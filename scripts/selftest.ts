/**
 * Selftest du module NL2SQL (sans appel LLM) :
 *
 *   npm run selftest        # lit DATABASE_URL dans .env (ou le shell)
 *
 * Vérifie : chargement du schéma, validation du SQL (cas acceptés/refusés),
 * exécution read-only, plafond de lignes, et que le rôle utilisé est bien
 * configuré en read-only. AUCUNE écriture persistante n'est effectuée :
 * la sonde d'écriture est faite dans une transaction annulée (ROLLBACK).
 */
import { Pool } from "pg";
import {
  executeReadonly,
  loadSchemaInfo,
  validateSql,
  SqlRejectedError,
  type Nl2SqlConfig,
} from "../nl2sql.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "DATABASE_URL requis.\n" +
      "  - soit dans .env à la racine du projet (chargé automatiquement par le script),\n" +
      "  - soit dans le shell : DATABASE_URL=postgres://... npm run selftest\n" +
      "  - base de démo locale : npm run demo:db (qui affiche l'URL à copier dans .env)"
  );
  process.exit(1);
}

// Masque le mot de passe pour l'affichage
const maskedUrl = url.replace(/:([^:@/]+)@/, ":***@");
console.log(`Connexion à : ${maskedUrl}\n`);

const pool = new Pool({ connectionString: url });
const cfg: Pick<Nl2SqlConfig, "maxRows" | "statementTimeoutMs"> = {
  maxRows: Number(process.env.NL2SQL_MAX_ROWS ?? 200),
  statementTimeoutMs: Number(process.env.NL2SQL_TIMEOUT_MS ?? 5000),
};
const schemaName = process.env.NL2SQL_SCHEMA ?? "public";

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  console.log(`${cond ? "PASS" : "FAIL"} - ${name}${extra ? ` (${extra})` : ""}`);
  if (!cond) failures++;
}

try {
  /* 1. Schéma chargé depuis pg_catalog */
  const schema = await loadSchemaInfo(pool, schemaName);
  check("schéma chargé depuis pg_catalog", schema.tables.length > 0, `${schema.tables.length} table(s) : ${schema.tables.slice(0, 8).join(", ")}${schema.tables.length > 8 ? "…" : ""}`);
  console.log("--- extrait du schéma exposé au LLM ---\n" + schema.text.split("\n").slice(0, 8).join("\n") + "\n---\n");

  // Requêtes de test construites à partir du schéma RÉEL (fonctionne sur la démo comme sur votre base)
  const t0 = schema.tables[0];
  const t1 = schema.tables[1] ?? schema.tables[0];
  const goodSql = [
    `SELECT * FROM ${t0} LIMIT 5`,
    schema.tables.length > 1 ? `SELECT a.*, b.* FROM ${t0} a JOIN ${t1} b ON true LIMIT 10` : `SELECT * FROM ${t0} a JOIN ${t0} b ON true LIMIT 10`,
    `WITH x AS (SELECT * FROM ${t0}) SELECT * FROM x LIMIT 5`,
    `SELECT count(*) AS n FROM ${t0};`,
  ];
  for (const sql of goodSql) {
    try {
      validateSql(sql, schema.tables, schemaName);
      check(`SQL accepté : ${sql.slice(0, 70)}`, true);
    } catch (e) {
      check(`SQL accepté : ${sql.slice(0, 70)}`, false, (e as Error).message);
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
      validateSql(sql, schema.tables, schemaName);
      check(`SQL refusé (${label})`, false, "accepté à tort !");
    } catch (e) {
      check(`SQL refusé (${label})`, e instanceof SqlRejectedError, (e as Error).message.slice(0, 60));
    }
  }

  /* 2. Exécution read-only + plafond de lignes */
  const sql = validateSql(`SELECT count(*) AS n FROM ${t0}`, schema.tables, schemaName);
  const res = await executeReadonly(pool, sql, cfg);
  check("exécution SELECT read-only", res.rows.length === 1, JSON.stringify(res.rows));

  const capped = await executeReadonly(pool, `SELECT * FROM ${t0}`, { ...cfg, maxRows: 3 });
  check("plafond de lignes appliqué", capped.rows.length <= 3, `rows=${capped.rows.length}`);

  /* 3. Le rôle est bien read-only : sonde non destructive (transaction annulée) */
  const ro = await pool.query("SHOW default_transaction_read_only");
  const setting = String(ro.rows[0]?.default_transaction_read_only);
  check("rôle configuré read-only (default_transaction_read_only=on)", setting === "on", `valeur actuelle : ${setting}`);

  // Sonde d'écriture non destructive : UPDATE sur 0 ligne (WHERE false) dans une
  // transaction systématiquement annulée. Si le rôle est read-only, PostgreSQL
  // refuse l'UPDATE ; s'il ne l'est pas, aucune ligne n'est modifiée (ROLLBACK).
  const colRes = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position LIMIT 1`,
    [schemaName, t0]
  );
  const col = String(colRes.rows[0]?.column_name ?? "");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    if (col) {
      await c.query(`UPDATE "${t0}" SET "${col}" = "${col}" WHERE false`);
    } else {
      await c.query(`DELETE FROM "${t0}" WHERE false`);
    }
    await c.query("ROLLBACK");
    check(
      "sonde d'écriture : le rôle NE devrait pas pouvoir écrire",
      false,
      "l'UPDATE a réussi -> ROLLBACK effectué (base intacte), mais utilisez un rôle read-only (db/00-roles.sql)"
    );
  } catch (e) {
    try {
      await c.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    const msg = (e as Error).message;
    check("sonde d'écriture bloquée par la base", /read-only/i.test(msg), msg.slice(0, 70));
  } finally {
    c.release();
  }
} finally {
  await pool.end();
}

console.log(failures === 0 ? "\n✅ TOUS LES TESTS PASSENT" : `\n❌ ${failures} ÉCHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
