/**
 * Selftest du module NL2SQL (sans appel LLM) :
 *
 *   npm run selftest        # lit DATABASE_URL / SQLITE_PATH dans .env (ou le shell)
 *
 * Vérifie pour chaque source configurée (PostgreSQL et/ou SQLite) : chargement
 * du schéma, validation du SQL (cas acceptés/refusés), exécution read-only,
 * plafond de lignes, et que la source refuse les écritures.
 * AUCUNE écriture persistante : sondes dans des transactions annulées (PG)
 * ou sur une connexion readOnly (SQLite).
 */
import { existsSync, readFileSync } from "node:fs";
import { Pool } from "pg";
import { DatabaseSync } from "node:sqlite";
import {
  createNl2Sql,
  createSqliteSource,
  executeReadonly,
  loadSchemaInfo,
  validateSql,
  SqlRejectedError,
} from "../nl2sql.js";
import { parseChartBlock, runChat, sanitizeMessages } from "../chat.js";

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  console.log(`${cond ? "PASS" : "FAIL"} - ${name}${extra ? ` (${extra})` : ""}`);
  if (!cond) failures++;
}

/* ---------------- PostgreSQL ---------------- */
const url = process.env.DATABASE_URL;
if (url) {
  const maskedUrl = url.replace(/:([^:@/]+)@/, ":***@");
  console.log(`--- Source PostgreSQL : ${maskedUrl} ---`);
  const pool = new Pool({ connectionString: url });
  const cfg = {
    maxRows: Number(process.env.NL2SQL_MAX_ROWS ?? 200),
    statementTimeoutMs: Number(process.env.NL2SQL_TIMEOUT_MS ?? 5000),
  };
  const schemaName = process.env.NL2SQL_SCHEMA ?? "public";
  try {
    const schema = await loadSchemaInfo(pool, schemaName);
    check("schéma pg chargé depuis pg_catalog", schema.tables.length > 0, `${schema.tables.length} table(s)`);

    const t0 = schema.tables[0];
    const t1 = schema.tables[1] ?? schema.tables[0];
    const goodSql = [
      `SELECT * FROM ${t0} LIMIT 5`,
      `SELECT a.*, b.* FROM ${t0} a JOIN ${t1} b ON true LIMIT 10`,
      `WITH x AS (SELECT * FROM ${t0}) SELECT * FROM x LIMIT 5`,
      `SELECT count(*) AS n FROM ${t0};`,
    ];
    for (const sql of goodSql) {
      try {
        validateSql(sql, schema.tables, { schemaName });
        check(`SQL pg accepté : ${sql.slice(0, 60)}`, true);
      } catch (e) {
        check(`SQL pg accepté : ${sql.slice(0, 60)}`, false, (e as Error).message);
      }
    }
    const badSql: Array<[string, string]> = [
      [`DELETE FROM ${t0}`, "DELETE"],
      [`UPDATE ${t0} SET 1=1`, "UPDATE"],
      [`SELECT * FROM ${t0}; DROP TABLE ${t0}`, "2 instructions"],
      ["SELECT * FROM pg_authid", "table système hors whitelist"],
      ["SELECT pg_sleep(10)", "fonction dangereuse"],
      [`SELECT * FROM ${t0} INTO TABLE copie`, "SELECT INTO"],
    ];
    for (const [sql, label] of badSql) {
      try {
        validateSql(sql, schema.tables, { schemaName });
        check(`SQL pg refusé (${label})`, false, "accepté à tort !");
      } catch (e) {
        check(`SQL pg refusé (${label})`, e instanceof SqlRejectedError, (e as Error).message.slice(0, 60));
      }
    }

    const sql = validateSql(`SELECT count(*) AS n FROM ${t0}`, schema.tables, { schemaName });
    const res = await executeReadonly(pool, sql, cfg);
    check("exécution pg read-only", res.rows.length === 1, JSON.stringify(res.rows));
    const capped = await executeReadonly(pool, `SELECT * FROM ${t0}`, { ...cfg, maxRows: 3 });
    check("plafond de lignes (pg)", capped.rows.length <= 3, `rows=${capped.rows.length}`);

    const ro = await pool.query("SHOW default_transaction_read_only");
    check("rôle pg read-only (default_transaction_read_only)", String(ro.rows[0]?.default_transaction_read_only) === "on", String(ro.rows[0]?.default_transaction_read_only));

    // Sonde d'écriture non destructive (BEGIN/ROLLBACK, WHERE false)
    const colRes = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position LIMIT 1`,
      [schemaName, t0]
    );
    const col = String(colRes.rows[0]?.column_name ?? "");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      if (col) await c.query(`UPDATE "${t0}" SET "${col}" = "${col}" WHERE false`);
      else await c.query(`DELETE FROM "${t0}" WHERE false`);
      await c.query("ROLLBACK");
      check("sonde d'écriture pg : le rôle NE devrait pas pouvoir écrire", false, "UPDATE réussi -> ROLLBACK, base intacte, mais utilisez un rôle read-only");
    } catch (e) {
      try { await c.query("ROLLBACK"); } catch { /* ignore */ }
      check("sonde d'écriture pg bloquée par la base", /read-only/i.test((e as Error).message), (e as Error).message.slice(0, 70));
    } finally {
      c.release();
    }
  } finally {
    await pool.end();
  }
} else {
  console.log("--- DATABASE_URL non défini : tests PostgreSQL ignorés ---");
}

/* ---------------- SQLite ---------------- */
const sqlitePath = process.env.SQLITE_PATH ?? (existsSync("structure.sqlite3") ? "structure.sqlite3" : undefined);
if (sqlitePath && existsSync(sqlitePath)) {
  console.log(`\n--- Source SQLite : ${sqlitePath} ---`);
  const src = createSqliteSource(sqlitePath, { name: "sqlite" });
  const tables = await src.listTables();
  check("schéma sqlite chargé", tables.length > 0, `${tables.length} table(s) : ${tables.join(", ")}`);
  console.log("--- extrait ---\n" + (await src.schemaText()).split("\n").slice(0, 8).join("\n") + "\n---");

  const t0 = tables[0];
  for (const sql of [`SELECT * FROM ${t0} LIMIT 5`, `SELECT count(*) AS n FROM ${t0}`]) {
    try {
      await src.validate(sql);
      check(`SQL sqlite accepté : ${sql.slice(0, 50)}`, true);
    } catch (e) {
      check(`SQL sqlite accepté : ${sql.slice(0, 50)}`, false, (e as Error).message);
    }
  }
  const badSql: Array<[string, string]> = [
    [`DELETE FROM ${t0}`, "DELETE"],
    ["SELECT * FROM sqlite_master", "table système hors whitelist"],
    ["ATTACH DATABASE 'x' AS y", "ATTACH"],
    ["SELECT load_extension('x')", "load_extension"],
    [`SELECT * FROM ${t0}; DROP TABLE ${t0}`, "2 instructions"],
  ];
  for (const [sql, label] of badSql) {
    try {
      await src.validate(sql);
      check(`SQL sqlite refusé (${label})`, false, "accepté à tort !");
    } catch (e) {
      check(`SQL sqlite refusé (${label})`, e instanceof SqlRejectedError, (e as Error).message.slice(0, 60));
    }
  }

  const res = await src.execute(await src.validate(`SELECT count(*) AS n FROM ${t0}`), 200, 5000);
  check("exécution sqlite read-only", res.rows.length === 1, JSON.stringify(res.rows));
  const capped = await src.execute(`SELECT * FROM ${t0}`, 3, 5000);
  check("plafond de lignes (sqlite)", capped.rows.length <= 3, `rows=${capped.rows.length}`);

  // Sonde d'écriture : connexion readOnly sur le même fichier
  const probe = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    probe.prepare(`DELETE FROM "${t0}" WHERE false`).run();
    check("sonde d'écriture sqlite : la base NE devrait pas être modifiable", false, "écriture acceptée !");
  } catch (e) {
    check("sonde d'écriture sqlite bloquée (readOnly)", /readonly|read-only/i.test((e as Error).message), (e as Error).message.slice(0, 70));
  } finally {
    probe.close();
  }
} else {
  console.log("\n--- SQLITE_PATH non défini et pas de structure.sqlite3 : tests SQLite ignorés ---");
}

/* ---------------- Chat contextuel (runChat avec LLM mocké) ---------------- */
if (sqlitePath && existsSync(sqlitePath)) {
  console.log(`\n--- Chat contextuel NL2SQL (LLM mocké, source sqlite) ---`);
  const src = createSqliteSource(sqlitePath, { name: "sqlite" });
  let llmCalls = 0;
  const fakeMistral: any = {
    chat: {
      complete: async () => {
        llmCalls++;
        if (llmCalls === 1) {
          // 1er tour : le modèle demande une requête SQL
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  toolCalls: [
                    {
                      id: "c1",
                      type: "function",
                      function: {
                        name: "run_readonly_sql",
                        arguments: JSON.stringify({
                          database: "sqlite",
                          sql: "SELECT count(*) AS n FROM licence",
                          explanation: "compte les licences",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          };
        }
        // 2e tour : réponse finale en citant le résultat de l'outil + bloc graphique
        return {
          choices: [
            {
              message: {
                role: "assistant",
                content:
                  "D'après la base sqlite, il y a 3 licences (résultat de la requête précédente).\n```chart\n{\"type\":\"bar\",\"title\":\"Licences\",\"labels\":[\"L1-INFO\",\"L2-INFO\",\"L3-MIAGE\"],\"values\":[1,1,1]}\n```",
              },
            },
          ],
        };
      },
    },
  };
  const nl2sql = createNl2Sql({
    mistral: fakeMistral,
    sources: [src],
    fileConfig: null,
    config: { model: "m", maxRows: 200, statementTimeoutMs: 5000, maxSampleBytes: 20000, maxToolRounds: 3 },
  });
  const r = await runChat(fakeMistral, nl2sql, [{ role: "user", content: "Combien de licences dans la structure ?" }], { model: "m", maxToolRounds: 3 });
  check("runChat : 1 appel outil exécuté sur sqlite", r.steps.length === 1 && r.steps[0].database === "sqlite" && !r.steps[0].error, JSON.stringify(r.steps[0]).slice(0, 140));
  check("runChat : réponse finale cite le résultat de la requête", r.reply.includes("3"), r.reply.slice(0, 70));
  check("runChat : append = assistant(toolCalls) + tool + assistant(final)", r.append.length === 3, `append=${r.append.length}`);
  check("runChat : bloc chart extrait et validé", r.chart !== null && r.chart.type === "bar" && r.chart.values.join() === "1,1,1", JSON.stringify(r.chart).slice(0, 100));
  check("runChat : le bloc ```chart est retiré du texte de réponse", !r.reply.includes("```chart") && r.reply.includes("3 licences"), r.reply.slice(0, 60));

  // parseChartBlock : cas nominaux et limites
  const sample = 'Voici le graphique :\n```chart\n{"type":"bar","title":"H<eures","labels":["A","B"],"values":[10,20.5]}\n```\nFin.';
  const p = parseChartBlock(sample);
  check("parseChartBlock extrait et nettoie", p.chart?.type === "bar" && p.chart.values[1] === 20.5 && !p.text.includes("```chart") && p.text.includes("Voici"), p.text.slice(0, 40));
  check("parseChartBlock sans bloc -> null", parseChartBlock("texte sans bloc").chart === null);
  check("parseChartBlock : JSON invalide -> null", parseChartBlock("```chart\n{nope}\n```").chart === null);
  check("parseChartBlock : longueurs labels/values différentes -> null", parseChartBlock('```chart\n{"type":"bar","labels":["a"],"values":[1,2]}\n```').chart === null);
  check("parseChartBlock : valeur non numérique -> null", parseChartBlock('```chart\n{"type":"bar","labels":["a"],"values":["x"]}\n```').chart === null);
  check("parseChartBlock : >100 points -> null", parseChartBlock('```chart\n{"type":"line","labels":[' + Array.from({ length: 101 }, (_, i) => `"l${i}"`).join(",") + '],"values":[' + Array.from({ length: 101 }, () => "1").join(",") + ']}\n```').chart === null);
  check("parseChartBlock : type inconnu -> bar par défaut", parseChartBlock('```chart\n{"type":"pie","labels":["a"],"values":[1]}\n```').chart?.type === "bar");

  // Styles : orientation + couleurs
  const styled = parseChartBlock('```chart\n{"type":"bar","orientation":"horizontal","color":"red","labels":["A","B"],"values":[3,7]}\n```');
  check("chart : orientation horizontal conservée", styled.chart?.orientation === "horizontal", JSON.stringify(styled.chart?.orientation));
  check("chart : couleur nommée conservée", styled.chart?.color === "red");
  const hex = parseChartBlock('```chart\n{"type":"bar","colors":["#ff0000","#00ff00"],"labels":["A","B"],"values":[1,2]}\n```');
  check("chart : palette colors conservée", hex.chart?.colors?.length === 2 && hex.chart.colors[0] === "#ff0000");
  const injected = parseChartBlock('```chart\n{"type":"bar","color":"red\\"><script>alert(1)</script>","labels":["A"],"values":[1]}\n```');
  check("chart : couleur dangereuse écartée (anti-injection SVG), graphique conservé", injected.chart !== null && injected.chart.color === undefined, `color=${injected.chart?.color}`);
  check("chart : orientation horizontal ignorée pour une courbe", parseChartBlock('```chart\n{"type":"line","orientation":"horizontal","labels":["a"],"values":[1]}\n```').chart?.orientation === "vertical");

  // L'historique rejoué (avec toolCalls + tool) doit être accepté : c'est le contexte du tour suivant
  const hist = [{ role: "user", content: "Combien de licences ?" }, ...r.append, { role: "user", content: "Et leurs parcours ?" }];
  const s = sanitizeMessages(hist);
  check("sanitizeMessages conserve l'historique avec toolCalls/tool (contexte)", s !== null && s.length === hist.length, `len=${s?.length}/${hist.length}`);
  check("sanitizeMessages supprime un message tool orphelin", sanitizeMessages([{ role: "tool", content: "x", toolCallId: "zzz" }, { role: "user", content: "a" }])?.some((m) => m.role === "tool") === false);
  check("sanitizeMessages refuse un rôle inconnu", sanitizeMessages([{ role: "hacker", content: "a" }]) === null);
  check("sanitizeMessages refuse un corps invalide", sanitizeMessages("pas un tableau") === null && sanitizeMessages([]) === null);
}

/* ---------------- Rendu markdown (public/markdown.js, fonction pure) ---------------- */
{
  console.log(`\n--- Rendu markdown (public/markdown.js) ---`);
  const mdSrc = readFileSync(new URL("../public/markdown.js", import.meta.url), "utf8");
  const mdToHtml = new Function(`${mdSrc}; return mdToHtml;`)() as (s: string) => string;
  check("md : gras", mdToHtml("**gras**").includes("<strong>gras</strong>"));
  check("md : italique", mdToHtml("*ital*").includes("<em>ital</em>"));
  check("md : code inline", mdToHtml("`SELECT 1`").includes("<code>SELECT 1</code>"));
  const codeBlock = mdToHtml("```html\n<b>x</b>\n```");
  check("md : bloc code échappé", codeBlock.includes("&lt;b&gt;") && !codeBlock.includes("<b>x</b>"));
  check("md : liste à puces", mdToHtml("- a\n- b").includes("<ul") && mdToHtml("- a\n- b").includes("<li>a</li>"));
  check("md : liste ordonnée", mdToHtml("1. a\n2. b").includes("<ol") && mdToHtml("1. a\n2. b").includes("<li>b</li>"));
  check("md : lien http autorisé", mdToHtml("[site](https://example.com)").includes('href="https://example.com"'));
  check("md : lien javascript: neutralisé", !mdToHtml("[x](javascript:alert(1))").includes("href"));
  check("md : HTML brut échappé (anti-XSS)", !mdToHtml("<script>alert(1)</script>").includes("<script>"));
  check("md : <img> brut échappé", !mdToHtml('<img src=x onerror=alert(1)>').includes("<img"));
  const tbl = mdToHtml("| nom | heures |\n|---|---|\n| Dupont | 30 |");
  check("md : tableau", tbl.includes("<table") && tbl.includes("<th") && tbl.includes("<td") && tbl.includes("Dupont</td>"));
  check("md : paragraphe avec saut de ligne", mdToHtml("ligne1\nligne2").includes("ligne1<br>ligne2"));
  check("md : titre", mdToHtml("## Titre").includes("<h4"));
  check("md : citation", mdToHtml("> note").includes("<blockquote"));
}

console.log(failures === 0 ? "\n✅ TOUS LES TESTS PASSENT" : `\n❌ ${failures} ÉCHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
