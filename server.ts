import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Mistral } from "@mistralai/mistralai";

const MODEL = "mistral-small-latest";
const PORT = Number(process.env.PORT ?? 3000);

const apiKey = process.env.MISTRAL_API_KEY;
if (!apiKey) {
  console.error(
    "Erreur : la variable d'environnement MISTRAL_API_KEY n'est pas définie."
  );
  console.error("Copiez .env.example en .env et renseignez votre clé API Mistral.");
  process.exit(1);
}

const client = new Mistral({ apiKey });

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

function contentToText(content: unknown): string {
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

app.listen(PORT, () => {
  console.log(`Chat Mistral (${MODEL}) disponible sur http://localhost:${PORT}`);
});
