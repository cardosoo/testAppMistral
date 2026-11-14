import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Mistral } from "@mistralai/mistralai";
import { Pool } from "pg";
import {
  createNl2Sql,
  createPostgresSource,
  createSqliteSource,
  loadFileConfig,
  SqlRejectedError,
  type DataSource,
  type Nl2Sql,
} from "./nl2sql.js";
import { ChatBadRequestError, runChat } from "./chat.js";

const MODEL = "mistral-small-latest";
const PORT = Number(process.env.PORT ?? 3000);

const apiKey = process.env.MISTRAL_API_KEY;
if (!apiKey) {
  console.error(
    "Erreur : la variable d'environnement MISTRAL_API_KEY n'est pas définie."
  );
  console.error(
    "Le fichier .env (racine du projet) est charg\u00e9 automatiquement au d\u00e9marrage ; sinon d\u00e9finissez MISTRAL_API_KEY dans votre shell."
  );
  process.exit(1);
}

const client = new Mistral({ apiKey });

// NL2SQL (optionnel) : actif si au moins une source est configurée :
//  - PostgreSQL via DATABASE_URL (rôle strictement read-only, voir db/ et README)
//  - SQLite via SQLITE_PATH (défaut : ./structure.sqlite3 s'il existe)
const sources: DataSource[] = [];

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  sources.push(
    createPostgresSource(pool, {
      name: process.env.NL2SQL_PG_NAME ?? "postgres",
      schemaName: process.env.NL2SQL_SCHEMA ?? "public",
      allowedTables: process.env.NL2SQL_ALLOWED_TABLES?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    })
  );
}

const sqlitePath =
  process.env.SQLITE_PATH ?? (existsSync("structure.sqlite3") ? "structure.sqlite3" : undefined);
if (sqlitePath && existsSync(sqlitePath)) {
  sources.push(createSqliteSource(sqlitePath, { name: process.env.SQLITE_NAME ?? "sqlite" }));
} else if (process.env.SQLITE_PATH) {
  console.warn(`SQLITE_PATH=${process.env.SQLITE_PATH} introuvable — source sqlite ignorée`);
}

let nl2sql: Nl2Sql | null = null;
if (sources.length > 0) {
  const fileConfig = loadFileConfig(process.env.NL2SQL_CONFIG ?? "nl2sql.config.json");
  if (fileConfig) {
    console.log(
      `Config NL2SQL chargée : ${Object.keys(fileConfig.tables ?? {}).length} table(s) décrite(s), ` +
        `${fileConfig.examples?.length ?? 0} exemple(s), ${fileConfig.rules?.length ?? 0} règle(s)`
    );
  }
  nl2sql = createNl2Sql({
    mistral: client,
    sources,
    fileConfig,
    config: {
      model: process.env.NL2SQL_MODEL ?? MODEL,
      maxRows: Number(process.env.NL2SQL_MAX_ROWS ?? 200),
      statementTimeoutMs: Number(process.env.NL2SQL_TIMEOUT_MS ?? 5000),
      maxSampleBytes: Number(process.env.NL2SQL_MAX_SAMPLE_BYTES ?? 20000),
      maxToolRounds: Number(process.env.NL2SQL_MAX_TOOL_ROUNDS ?? 4),
    },
  });
  console.log(`NL2SQL activé, sources : ${sources.map((s) => `"${s.name}" (${s.label})`).join(", ")}`);
} else {
  console.log("NL2SQL désactivé (ni DATABASE_URL ni SQLITE_PATH) — /api/chat fonctionne sans accès aux bases");
}

const app = express();
app.use(express.json({ limit: "256kb" }));

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
app.use(express.static(publicDir));

// Chat conversationnel. Si des sources NL2SQL sont configurées, le modèle a
// aussi accès à l'outil run_readonly_sql : il peut interroger les bases DANS la
// conversation, avec l'historique (dont résultats de requêtes précédentes) comme
// contexte. Réponse : { reply, steps, append } — "append" = messages à rejouer
// dans l'historique client (assistant avec toolCalls, messages tool, réponse finale).
app.post("/api/chat", async (req, res) => {
  try {
    const result = await runChat(client, nl2sql, req.body?.messages, {
      model: MODEL,
      maxToolRounds: Number(process.env.NL2SQL_MAX_TOOL_ROUNDS ?? 4),
    });
    return res.json(result);
  } catch (e) {
    if (e instanceof ChatBadRequestError) {
      return res.status(400).json({ error: e.message });
    }
    console.error("Erreur API Mistral :", e);
    return res.status(502).json({ error: "Échec de l'appel à l'API Mistral." });
  }
});

app.post("/api/ask-db", async (req, res) => {
  const question =
    typeof req.body?.question === "string" ? req.body.question.trim() : "";
  if (!question || question.length > 2000) {
    return res
      .status(400)
      .json({ error: "Champ 'question' requis (1 à 2000 caractères)." });
  }
  if (!nl2sql) {
    return res.status(503).json({
      error:
        "NL2SQL non configuré : définissez DATABASE_URL (rôle PostgreSQL read-only) et/ou SQLITE_PATH (fichier .sqlite3) dans .env.",
    });
  }
  try {
    return res.json(await nl2sql.ask(question));
  } catch (e) {
    if (e instanceof SqlRejectedError) {
      console.warn("[nl2sql] SQL refusé :", e.message);
      return res.status(400).json({
        error: "La requête générée a été refusée pour des raisons de sécurité.",
        detail: e.message,
      });
    }
    console.error("[nl2sql] erreur :", e);
    return res
      .status(502)
      .json({ error: "Échec du traitement de la question (LLM ou base indisponible)." });
  }
});

app.listen(PORT, () => {
  console.log(`Chat Mistral (${MODEL}) disponible sur http://localhost:${PORT}`);
});
