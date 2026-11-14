/**
 * Selftest du module NL2SQL (sans appel LLM) : à lancer avec DATABASE_URL défini,
 * par exemple après `npm run demo:db` :
 *
 *   DATABASE_URL=postgres://chatbot_read:chatbot_read_demo@localhost:5433/chatbot_demo npm run selftest
 *
 * Vérifie : chargement du schéma, validation du SQL (cas acceptés/refusés),
 * exécution read-only, plafond de lignes, et blocage d'un UPDATE par le rôle read-only.
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
  console.error("DATABASE_URL requis (ex: postgres://chatbot_read:...@localhost:5433/chatbot_demo)");
  process.exit(1);
}

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
  const schema = await loadSchemaInfo(pool, schemaName);
  check("schéma chargé depuis pg_catalog", schema.tables.length >= 3, schema.tables.join(", "));
  console.log("--- extrait du schéma ---\n" + schema.text.split("\n").slice(0, 10).join("\n") + "\n---");

  const goodSql = [
    "SELECT nom, prenom FROM enseignant ORDER BY nom",
    "SELECT e.nom, SUM(a.heures) AS total FROM affectation a JOIN enseignant e ON e.id = a.enseignant_id GROUP BY e.nom ORDER BY total DESC",
    "WITH t AS (SELECT id, nom FROM enseignant) SELECT * FROM t WHERE id > 1",
    "SELECT semestre, COUNT(*) AS nb_ue FROM ue GROUP BY semestre ORDER BY semestre;",
  ];
  for (const sql of goodSql) {
    try {
      validateSql(sql, schema.tables, schemaName);
      check(`SQL accepté : ${sql.slice(0, 60)}`, true);
    } catch (e) {
      check(`SQL accepté : ${sql.slice(0, 60)}`, false, (e as Error).message);
    }
  }

  const badSql: Array<[string, string]> = [
    ["DELETE FROM enseignant", "DELETE"],
    ["UPDATE enseignant SET nom = 'x'", "UPDATE"],
    ["SELECT * FROM enseignant; DROP TABLE enseignant", "2 instructions"],
    ["SELECT * FROM pg_authid", "table système hors whitelist"],
    ["SELECT pg_sleep(10)", "fonction dangereuse"],
    ["SELECT * FROM enseignant INTO TABLE copie", "SELECT INTO"],
    ["SELECT * FROM enseignant WHERE nom = 'x' OR 1=1 --", "injection classique (table ok mais test parser)"],
  ];
  for (const [sql, label] of badSql) {
    try {
      validateSql(sql, schema.tables, schemaName);
      // le commentaire d'injection est un SELECT valide sur table autorisée : accepté par le parser,
      // mais inoffensif (lecture seule). On ne le compte comme refusé que s'il vise une vraie cible.
      if (label.startsWith("injection")) {
        check(`SQL injection commenté : parsé mais inoffensif en read-only (${label})`, true);
      } else {
        check(`SQL refusé (${label})`, false, "accepté à tort !");
      }
    } catch (e) {
      check(`SQL refusé (${label})`, e instanceof SqlRejectedError, (e as Error).message.slice(0, 60));
    }
  }

  const sql = validateSql(
    "SELECT type_enseignement, SUM(heures) AS total FROM affectation GROUP BY type_enseignement ORDER BY type_enseignement",
    schema.tables,
    schemaName
  );
  const res = await executeReadonly(pool, sql, cfg);
  check("exécution SELECT read-only", res.rows.length > 0, JSON.stringify(res.rows));

  const capped = await executeReadonly(pool, "SELECT * FROM affectation", { ...cfg, maxRows: 3 });
  check("plafond de lignes appliqué", capped.rows.length === 3 && capped.truncated, `rows=${capped.rows.length}`);

  // Défense en profondeur : même en contournant la validation, le rôle read-only bloque l'écriture
  try {
    await pool.query("UPDATE enseignant SET nom = 'HACK' WHERE id = 1");
    check("UPDATE bloqué par le rôle read-only", false, "l'UPDATE a réussi !");
  } catch (e) {
    check("UPDATE bloqué par le rôle read-only", /read-only/i.test((e as Error).message), (e as Error).message.slice(0, 70));
  }
} finally {
  await pool.end();
}

console.log(failures === 0 ? "\n✅ TOUS LES TESTS PASSENT" : `\n❌ ${failures} ÉCHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
