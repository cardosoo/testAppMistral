import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { DatabaseSync } from "node:sqlite";
import NodeSqlParser from "node-sql-parser";
import type { Mistral } from "@mistralai/mistralai";

// node-sql-parser est un paquet CommonJS : on passe par l'import par défaut.
const { Parser } = NodeSqlParser;

/**
 * Module NL2SQL générique et MULTI-SOURCES : traduit une question en langage
 * naturel en requêtes SQL SELECT exécutées en lecture seule sur une ou
 * plusieurs sources (PostgreSQL et/ou fichiers SQLite), puis laisse le LLM
 * croiser les résultats et reformuler la réponse en français.
 *
 * Le croisement entre bases ne se fait PAS en SQL (pas de jointure cross-DB
 * entre PostgreSQL et SQLite) : l'orchestrateur enchaîne un appel d'outil par
 * source, renvoie chaque résultat au LLM, qui poursuit puis synthétise.
 *
 * Défense en profondeur (par source) :
 *  1. validation applicative du SQL (parser + whitelist de tables + SELECT seul)
 *  2. plafonnement des lignes ; transaction READ ONLY + statement_timeout (PG)
 *     ; ouverture readOnly + PRAGMA query_only (SQLite)
 *  3. rôle PostgreSQL read-only côté base
 */

export type SqlDialect = "PostgreSQL" | "SQLite";

export interface Nl2SqlConfig {
  model: string;
  maxRows: number;
  statementTimeoutMs: number;
  maxSampleBytes: number;
  maxToolRounds: number;
}

export interface ExecResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

export interface AskStep {
  database: string;
  sql: string;
  explanation?: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  error?: string;
}

export interface AskDbResult {
  answer: string;
  steps: AskStep[];
}

export interface SchemaInfo {
  text: string;
  tables: string[];
}

export class SqlRejectedError extends Error {}

/** Extrait le texte d'un contenu de message Mistral (string ou chunks). */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((chunk) =>
        typeof chunk === "object" && chunk !== null && "text" in chunk
          ? String((chunk as { text?: unknown }).text ?? "")
          : ""
      )
      .join("");
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* Fichier de configuration métier (nl2sql.config.json)               */
/*                                                                    */
/* En complément des COMMENT ON PostgreSQL (lus via pg_catalog), ce   */
/* fichier décrit le sens métier des tables, le vocabulaire, les      */
/* chemins de jointure et des exemples question -> SQL (few-shot).    */
/* La clé optionnelle "sources" permet de décrire chaque source       */
/* individuellement (utile pour SQLite, qui n'a pas de COMMENT ON).   */
/* ------------------------------------------------------------------ */

export interface Nl2SqlTableDoc {
  description?: string;
  aliases?: string[];
  columns?: Record<string, string>;
  joins?: string[];
}

export interface Nl2SqlFileConfig {
  databaseDescription?: string;
  joinPaths?: string[];
  tables?: Record<string, Nl2SqlTableDoc>;
  rules?: string[];
  examples?: { question: string; sql: string; database?: string }[];
  sources?: Record<string, { description?: string; tables?: Record<string, Nl2SqlTableDoc>; rules?: string[] }>;
}

/** Charge le fichier de config JSON (chemin absolu ou relatif au cwd). Retourne null s'il n'existe pas. */
export function loadFileConfig(configPath?: string): Nl2SqlFileConfig | null {
  const p = path.resolve(configPath ?? "nl2sql.config.json");
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Nl2SqlFileConfig;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("le JSON racine doit être un objet");
    }
    return parsed;
  } catch (e) {
    console.warn(`[nl2sql] config ${p} illisible, ignorée : ${(e as Error).message}`);
    return null;
  }
}

function renderTableDoc(lines: string[], indent: string, t: string, td: Nl2SqlTableDoc): void {
  lines.push(`${indent}Table "${t}"${td.description ? ` : ${td.description}` : ""}`);
  if (td.aliases?.length) lines.push(`${indent}  - mots-clés/alias : ${td.aliases.join(", ")}`);
  if (td.columns) {
    for (const [c, d] of Object.entries(td.columns)) lines.push(`${indent}  - ${c} : ${d}`);
  }
  if (td.joins?.length) for (const j of td.joins) lines.push(`${indent}  - jointure : ${j}`);
}

/** Section « description métier » globale, ajoutée au prompt système. */
export function buildConfigSection(fc: Nl2SqlFileConfig | null): string {
  if (!fc) return "";
  const lines: string[] = ["", "=== Description métier (fichier nl2sql.config.json) ==="];
  if (fc.databaseDescription) lines.push(`Base : ${fc.databaseDescription}`);
  if (fc.joinPaths?.length) {
    lines.push("", "Chemins de jointure recommandés :");
    for (const j of fc.joinPaths) lines.push(`  - ${j}`);
  }
  if (fc.tables) {
    for (const [t, td] of Object.entries(fc.tables)) renderTableDoc(lines, "", t, td);
  }
  if (fc.rules?.length) {
    lines.push("", "Règles métier :");
    for (const r of fc.rules) lines.push(`  - ${r}`);
  }
  return lines.join("\n");
}

/** Sections par source (clé "sources" du fichier de config). */
export function buildSourcesSection(fc: Nl2SqlFileConfig | null): string {
  if (!fc?.sources) return "";
  const lines: string[] = ["", "=== Description métier PAR SOURCE ==="];
  for (const [src, sd] of Object.entries(fc.sources)) {
    lines.push(`Source "${src}"${sd.description ? ` : ${sd.description}` : ""}`);
    if (sd.tables) for (const [t, td] of Object.entries(sd.tables)) renderTableDoc(lines, "  ", t, td);
    if (sd.rules?.length) for (const r of sd.rules) lines.push(`  - règle : ${r}`);
  }
  return lines.join("\n");
}

/** Bloc d'exemples few-shot (question -> SQL) ajouté au prompt système. */
export function buildExamplesBlock(fc: Nl2SqlFileConfig | null): string {
  if (!fc?.examples?.length) return "";
  const lines = ["", "=== Exemples (question -> SQL attendu) ==="];
  for (const e of fc.examples) {
    lines.push(`Q: ${e.question}${e.database ? ` [source: ${e.database}]` : ""}\nSQL: ${e.sql}`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Validation du SQL généré par le LLM                                */
/* ------------------------------------------------------------------ */

const FORBIDDEN_FUNCTIONS =
  /\b(pg_sleep|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_ls_waldir|lo_import|lo_export|lo_read|lo_write|dblink|dblink_connect|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|setseed|load_extension)\s*\(/i;

function walkAst(node: unknown, tables: Set<string>, ctes: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkAst(item, tables, ctes);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.with)) {
    for (const w of obj.with as Record<string, any>[]) {
      const name = w?.name?.value ?? w?.name?.table;
      if (typeof name === "string") ctes.add(name.toLowerCase());
      walkAst(w?.stmt, tables, ctes);
    }
  }
  if (Array.isArray(obj.from)) {
    for (const f of obj.from as Record<string, any>[]) {
      if (typeof f?.table === "string") tables.add(f.table.toLowerCase());
      if (f?.db && typeof f.db === "string") tables.add(`__db__${f.db.toLowerCase()}`);
      walkAst(f?.ast, tables, ctes);
      walkAst(f?.on, tables, ctes);
    }
  }
  for (const key of Object.keys(obj)) {
    if (key === "from" || key === "with") continue;
    walkAst(obj[key], tables, ctes);
  }
}

/**
 * Valide une requête générée par le LLM et renvoie le SQL nettoyé.
 * N'accepte qu'un unique SELECT portant uniquement sur les tables autorisées.
 * Lance SqlRejectedError sinon.
 */
export function validateSql(
  rawSql: string,
  allowedTables: string[],
  opts: { schemaName?: string; dialect?: SqlDialect } = {}
): string {
  const dialect = opts.dialect ?? "PostgreSQL";
  const schemaName = opts.schemaName ?? "public";
  let sql = rawSql.trim();
  while (sql.endsWith(";")) sql = sql.slice(0, -1).trim();
  if (!sql) throw new SqlRejectedError("SQL vide");
  if (sql.length > 8000) throw new SqlRejectedError("SQL trop long");
  if (FORBIDDEN_FUNCTIONS.test(sql)) throw new SqlRejectedError("fonction interdite détectée");

  const parser = new Parser();
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: dialect });
  } catch {
    throw new SqlRejectedError("SQL non parsable");
  }
  if (Array.isArray(ast)) throw new SqlRejectedError("une seule instruction autorisée");
  const root = ast as Record<string, any>;
  if (root.type !== "select") throw new SqlRejectedError("seul un SELECT est autorisé");
  if (root.into && (root.into.table || root.into.position)) throw new SqlRejectedError("SELECT INTO interdit");

  const tables = new Set<string>();
  const ctes = new Set<string>();
  walkAst(root, tables, ctes);

  const allowed = new Set(allowedTables.map((t) => t.toLowerCase()));
  for (const t of tables) {
    if (t.startsWith("__db__")) {
      if (dialect === "PostgreSQL" && t !== `__db__${schemaName.toLowerCase()}`) {
        throw new SqlRejectedError(`schéma non autorisé : ${t.slice(6)}`);
      }
      continue;
    }
    if (ctes.has(t)) continue;
    if (!allowed.has(t)) throw new SqlRejectedError(`table non autorisée : ${t}`);
  }
  return sql;
}

/* ------------------------------------------------------------------ */
/* Sources de données                                                 */
/* ------------------------------------------------------------------ */

export interface DataSource {
  name: string;
  kind: "postgres" | "sqlite";
  dialect: SqlDialect;
  label: string;
  listTables(): Promise<string[]>;
  schemaText(): Promise<string>;
  validate(sql: string): Promise<string>;
  execute(sql: string, maxRows: number, timeoutMs: number): Promise<ExecResult>;
}

/* --- PostgreSQL (rôle read-only, transaction READ ONLY + timeout) --- */

export async function loadSchemaInfo(
  pool: Pool,
  schemaName: string,
  allowedTables?: string[]
): Promise<SchemaInfo> {
  const tablesRes = await pool.query<{ table_name: string; comment: string | null }>(
    `SELECT c.relname AS table_name, pg_catalog.obj_description(c.oid, 'pg_class') AS comment
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind IN ('r', 'v', 'm')
     ORDER BY c.relname`,
    [schemaName]
  );

  const fkRes = await pool.query<{
    table_name: string;
    column_name: string;
    foreign_table: string;
    foreign_column: string;
  }>(
    `SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
     ORDER BY tc.table_name, kcu.column_name`,
    [schemaName]
  );

  const lines: string[] = [`Schéma PostgreSQL "${schemaName}" :`, ""];
  const tables: string[] = [];

  for (const t of tablesRes.rows) {
    if (allowedTables && !allowedTables.includes(t.table_name)) continue;
    tables.push(t.table_name);
    lines.push(`Table "${t.table_name}"${t.comment ? ` — ${t.comment}` : ""}`);
    const colRes = await pool.query<{
      column_name: string;
      data_type: string;
      comment: string | null;
      is_pk: boolean;
    }>(
      `SELECT a.attname AS column_name,
              pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
              pg_catalog.col_description(a.attrelid, a.attnum) AS comment,
              EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con
                      WHERE con.conrelid = a.attrelid AND con.contype = 'p'
                        AND a.attnum = ANY(con.conkey)) AS is_pk
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [schemaName, t.table_name]
    );
    for (const c of colRes.rows) {
      lines.push(
        `  - ${c.column_name} ${c.data_type}${c.is_pk ? " (PK)" : ""}${c.comment ? ` — ${c.comment}` : ""}`
      );
    }
    lines.push("");
  }

  if (fkRes.rows.length > 0) {
    lines.push("Clés étrangères :");
    for (const fk of fkRes.rows) {
      lines.push(`  - ${fk.table_name}.${fk.column_name} -> ${fk.foreign_table}.${fk.foreign_column}`);
    }
  }

  return { text: lines.join("\n"), tables };
}

export async function executeReadonly(
  pool: Pool,
  sql: string,
  cfg: { maxRows: number; statementTimeoutMs: number }
): Promise<ExecResult> {
  const wrapped = `SELECT * FROM (${sql}) AS nl2sql_q LIMIT ${Math.max(1, cfg.maxRows)}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${Math.max(500, cfg.statementTimeoutMs)}`);
    const res = await client.query(wrapped);
    await client.query("COMMIT");
    return {
      columns: res.fields.map((f) => f.name),
      rows: res.rows as Record<string, unknown>[],
      rowCount: res.rowCount ?? res.rows.length,
      truncated: res.rows.length >= cfg.maxRows,
    };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

export function createPostgresSource(
  pool: Pool,
  opts: { name?: string; schemaName?: string; allowedTables?: string[] } = {}
): DataSource {
  const name = opts.name ?? "postgres";
  const schemaName = opts.schemaName ?? "public";
  let cached: SchemaInfo | null = null;
  const getSchema = async (): Promise<SchemaInfo> =>
    (cached ??= await loadSchemaInfo(pool, schemaName, opts.allowedTables));
  return {
    name,
    kind: "postgres",
    dialect: "PostgreSQL",
    label: `PostgreSQL, schéma "${schemaName}"`,
    listTables: async () => (await getSchema()).tables,
    schemaText: async () => (await getSchema()).text,
    validate: async (sql) => validateSql(sql, (await getSchema()).tables, { schemaName, dialect: "PostgreSQL" }),
    execute: (sql, maxRows, timeoutMs) =>
      executeReadonly(pool, sql, { maxRows, statementTimeoutMs: timeoutMs }),
  };
}

/* --- SQLite (fichier, ouvert readOnly + PRAGMA query_only) --- */

export function createSqliteSource(filePath: string, opts: { name?: string } = {}): DataSource {
  const name = opts.name ?? "sqlite";
  const db = new DatabaseSync(filePath, { readOnly: true });
  db.exec("PRAGMA query_only = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  let cached: SchemaInfo | null = null;
  const getSchema = async (): Promise<SchemaInfo> => {
    if (cached) return cached;
    const objs = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[];
    const tables = objs.map((o) => o.name);
    const lines: string[] = [`Schéma SQLite "${filePath}" (pas de commentaires natifs : voir nl2sql.config.json) :`, ""];
    const fks: string[] = [];
    for (const t of tables) {
      lines.push(`Table "${t}"`);
      const cols = db.prepare(`PRAGMA table_info("${t}")`).all() as {
        name: string;
        type: string;
        pk: number;
      }[];
      for (const c of cols) lines.push(`  - ${c.name} ${c.type}${c.pk ? " (PK)" : ""}`);
      const fkRows = db.prepare(`PRAGMA foreign_key_list("${t}")`).all() as {
        table: string;
        from: string;
        to: string;
      }[];
      for (const fk of fkRows) fks.push(`  - ${t}.${fk.from} -> ${fk.table}.${fk.to ?? "id"}`);
      lines.push("");
    }
    if (fks.length) lines.push("Clés étrangères :", ...fks);
    cached = { text: lines.join("\n"), tables };
    return cached;
  };

  return {
    name,
    kind: "sqlite",
    dialect: "SQLite",
    label: `SQLite, fichier "${filePath}"`,
    listTables: async () => (await getSchema()).tables,
    schemaText: async () => (await getSchema()).text,
    validate: async (sql) => validateSql(sql, (await getSchema()).tables, { dialect: "SQLite" }),
    execute: async (sql, maxRows) => {
      const wrapped = `SELECT * FROM (${sql}) AS nl2sql_q LIMIT ${Math.max(1, maxRows)}`;
      const stmt = db.prepare(wrapped);
      const rows = stmt.all() as Record<string, unknown>[];
      const colsFn = (stmt as unknown as { columns?: () => { name: string }[] }).columns;
      const columns = colsFn ? colsFn.call(stmt).map((c) => c.name) : Object.keys(rows[0] ?? {});
      return { columns, rows, rowCount: rows.length, truncated: rows.length >= maxRows };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Orchestration LLM multi-sources : question -> appels d'outils       */
/* par source -> synthèse en français                                  */
/* ------------------------------------------------------------------ */

export interface Nl2SqlDeps {
  mistral: Mistral;
  sources: DataSource[];
  fileConfig?: Nl2SqlFileConfig | null;
  config: Nl2SqlConfig;
}

export function createNl2Sql(deps: Nl2SqlDeps) {
  const sourceByName = new Map(deps.sources.map((s) => [s.name, s]));

  async function buildSystemPrompt(): Promise<string> {
    const sourceSchemas: string[] = [];
    for (const s of deps.sources) {
      sourceSchemas.push(`--- Source "${s.name}" (${s.label}) ---\n${await s.schemaText()}`);
    }
    const fc = deps.fileConfig ?? null;
    return [
      "Tu es un assistant NL2SQL multi-bases, strictement en lecture seule.",
      `Bases disponibles : ${deps.sources.map((s) => `"${s.name}" (${s.label})`).join(", ")}.`,
      "Tu traduis la question de l'utilisateur en requêtes SQL SELECT via l'outil run_readonly_sql",
      "(paramètre database = nom de la source à interroger).",
      "Pour CROISER plusieurs bases : fais plusieurs appels d'outil (un par source) ; les résultats",
      "des appels précédents reviennent dans la conversation. Quand tu as assez de données, réponds",
      "en français SANS appeler d'outil, en citant les chiffres exacts et les sources utilisées.",
      "",
      "Règles strictes :",
      "- une seule instruction SELECT par appel ; jamais d'écriture (INSERT/UPDATE/DELETE/DDL/ATTACH/PRAGMA) ; pas de SELECT INTO ;",
      "- uniquement les tables de la source choisie (schémas ci-dessous) ; CTE WITH autorisées ;",
      "- joins uniquement via les clés étrangères / chemins de jointure listés ;",
      "- ILIKE '%...%' (PostgreSQL) ou LIKE '%...%' (SQLite) pour les noms partiels ;",
      "- pas de point-virgule final ;",
      "- si la question sort du périmètre, réponds en texte sans appeler l'outil.",
      "",
      sourceSchemas.join("\n\n"),
      buildConfigSection(fc),
      buildSourcesSection(fc),
      buildExamplesBlock(fc),
    ].join("\n");
  }

  const sqlTool = {
    type: "function" as const,
    function: {
      name: "run_readonly_sql",
      description:
        "Exécute UNE requête SQL SELECT en lecture seule sur la source indiquée. " +
        "Ne jamais modifier les bases. N'utiliser que les tables de la source choisie.",
      parameters: {
        type: "object",
        properties: {
          database: {
            type: "string",
            enum: deps.sources.map((s) => s.name),
            description: "nom de la source à interroger",
          },
          sql: {
            type: "string",
            description:
              "Requête SELECT valide pour cette source : une seule instruction, sans point-virgule final, " +
              "uniquement sur les tables de la source.",
          },
          explanation: {
            type: "string",
            description: "Explication courte en français de la requête (pour l'utilisateur).",
          },
        },
        required: ["database", "sql"],
      },
    },
  };

  async function ask(question: string): Promise<AskDbResult> {
    const systemPrompt = await buildSystemPrompt();
    const messages: Record<string, unknown>[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: question },
    ];
    const steps: AskStep[] = [];

    let rounds = 0;
    while (rounds < deps.config.maxToolRounds) {
      rounds++;
      const completion = await deps.mistral.chat.complete({
        model: deps.config.model,
        messages: messages as never,
        tools: [sqlTool],
        toolChoice: "auto",
      });
      const message = completion.choices?.[0]?.message;
      messages.push(message as unknown as Record<string, unknown>);
      const toolCalls = (message?.toolCalls ?? []) as {
        id?: string;
        function: { name: string; arguments: unknown };
      }[];

      if (toolCalls.length === 0) {
        return {
          answer: contentToText(message?.content) || "Je n'ai pas pu répondre à cette question.",
          steps,
        };
      }

      for (const call of toolCalls) {
        const rawArgs = call.function.arguments;
        const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
        const dbName = String((args as { database?: unknown })?.database ?? "");
        const source = sourceByName.get(dbName);
        const step: AskStep = {
          database: dbName || "?",
          sql: String((args as { sql?: unknown })?.sql ?? ""),
          explanation: (args as { explanation?: string })?.explanation,
          columns: [],
          rows: [],
          rowCount: 0,
          truncated: false,
        };
        steps.push(step);
        if (!source) {
          step.error = `source inconnue "${dbName}" (disponibles : ${[...sourceByName.keys()].join(", ")})`;
        } else {
          try {
            step.sql = await source.validate(step.sql);
            const exec = await source.execute(step.sql, deps.config.maxRows, deps.config.statementTimeoutMs);
            Object.assign(step, exec);
          } catch (e) {
            step.error =
              e instanceof SqlRejectedError
                ? `SQL refusé : ${e.message}`
                : `erreur d'exécution : ${(e as Error).message}`;
          }
        }
        const payload = JSON.stringify({
          database: step.database,
          sql: step.sql,
          error: step.error,
          columns: step.columns,
          rowCount: step.rowCount,
          truncated: step.truncated,
          rows: step.rows,
        }).slice(0, deps.config.maxSampleBytes);
        messages.push({ role: "tool", toolCallId: call.id ?? `call-${steps.length}`, content: payload });
      }
    }

    // Nombre max de rounds atteint : synthèse finale à partir des résultats obtenus
    const final = await deps.mistral.chat.complete({
      model: deps.config.model,
      messages: [
        ...(messages as never[]),
        { role: "user", content: "Donne maintenant la réponse finale en français à partir des résultats obtenus, sans appeler d'outil." },
      ] as never,
    });
    return {
      answer: contentToText(final.choices?.[0]?.message?.content) || "Requêtes exécutées (voir le détail).",
      steps,
    };
  }

  return { ask, buildSystemPrompt };
}

export type Nl2Sql = ReturnType<typeof createNl2Sql>;
