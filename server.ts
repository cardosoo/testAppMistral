import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Mistral } from "@mistralai/mistralai";
import { Pool } from "pg";
import {
  contentToText,
  createNl2Sql,
  SqlRejectedError,
  type Nl2Sql,
} from "./nl2sql.js";

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

// NL2SQL (optionnel) : actif uniquement si DATABASE_URL pointe vers un rôle
// PostgreSQL strictement read-only (voir db/ et README).
const databaseUrl = process.env.DATABASE_URL;
let nl2sql: Nl2Sql | null = null;
if (databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  nl2sql = createNl2Sql({
    mistral: client,
    pool,
    config: {
      databaseUrl,
      schemaName: process.env.NL2SQL_SCHEMA ?? "public",
      maxRows: Number(process.env.NL2SQL_MAX_ROWS ?? 200),
      statementTimeoutMs: Number(process.env.NL2SQL_TIMEOUT_MS ?? 5000),
      model: process.env.NL2SQL_MODEL ?? MODEL,
      maxSampleBytes: Number(process.env.NL2SQL_MAX_SAMPLE_BYTES ?? 20000),
    },
  });
  console.log("NL2SQL activé (schéma PostgreSQL interrogable via POST /api/ask-db)");
} else {
  console.log("NL2SQL désactivé (DATABASE_URL non défini) — seul POST /api/chat est actif");
}

const app = express();
app.use(express.json({ limit: "256kb" }));

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
app.use(express.static(publicDir));

type Role = "system" | "user" | "assistant";
interface ChatMessage {
  role: Role;
  content: string;
}

const ROLES: ReadonlySet<string> = new Set(["system", "user", "assistant"]);

function sanitizeMessages(input: unknown): ChatMessage[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) {
    return null;
  }
  const messages: ChatMessage[] = [];
  for (const item of input) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as { role?: unknown }).role !== "string" ||
      !ROLES.has((item as { role: string }).role) ||
      typeof (item as { content?: unknown }).content !== "string" ||
      (item as { content: string }).content.length > 8000
    ) {
      return null;
    }
    messages.push({
      role: (item as { role: Role }).role,
      content: (item as { content: string }).content,
    });
  }
  return messages;
}

app.post("/api/chat", async (req, res) => {
  const messages = sanitizeMessages(req.body?.messages);
  if (!messages) {
    return res
      .status(400)
      .json({ error: "Corps attendu : { messages: [{ role, content }] }" });
  }

  try {
    const completion = await client.chat.complete({ model: MODEL, messages });
    const reply = contentToText(completion.choices?.[0]?.message?.content);
    return res.json({ reply });
  } catch (error) {
    console.error("Erreur API Mistral :", error);
    return res
      .status(502)
      .json({ error: "Échec de l'appel à l'API Mistral." });
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
        "NL2SQL non configuré : définissez DATABASE_URL (rôle PostgreSQL read-only) dans .env.",
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
