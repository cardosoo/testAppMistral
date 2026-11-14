import type { Mistral } from "@mistralai/mistralai";
import {
  contentToText,
  type AskStep,
  type Nl2Sql,
  type ToolCallLike,
} from "./nl2sql.js";

/**
 * Chat conversationnel, éventuellement augmenté des outils NL2SQL.
 *
 * L'historique envoyé par le client peut contenir des messages "assistant"
 * avec toolCalls et des messages "tool" (résultats de requêtes précédentes) :
 * c'est ce qui donne du CONTEXTE au NL2SQL dans le chat — le modèle voit les
 * résultats des requêtes précédentes et peut enchaîner (ex: trouver des
 * personnes, puis demander leurs enseignements dans la foulée).
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatToolCall {
  id?: string;
  type?: string;
  function: { name: string; arguments: unknown };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  toolCallId?: string;
  toolCalls?: ChatToolCall[];
}

export class ChatBadRequestError extends Error {}

const ROLES: ReadonlySet<string> = new Set(["system", "user", "assistant", "tool"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Valide/nettoie l'historique reçu. Ne conserve que les champs connus.
 * - system/user : content string requis
 * - assistant : content string|null, toolCalls optionnels (name + arguments)
 * - tool : content string + toolCallId, et seulement si un toolCall correspondant
 *   existe dans un message assistant précédent (sinon le message est supprimé)
 */
export function sanitizeMessages(input: unknown): ChatMessage[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) return null;
  const out: ChatMessage[] = [];
  const pendingToolIds = new Set<string>();
  for (const item of input) {
    if (!isPlainObject(item)) return null;
    const role = item.role;
    if (typeof role !== "string" || !ROLES.has(role)) return null;
    const content = item.content;

    if (role === "system" || role === "user") {
      if (typeof content !== "string" || content.length === 0 || content.length > 8000) return null;
      out.push({ role, content });
      continue;
    }
    if (role === "assistant") {
      if (content !== null && typeof content !== "string") return null;
      if (content && content.length > 8000) return null;
      const msg: ChatMessage = { role, content: content ?? null };
      if (Array.isArray(item.toolCalls)) {
        if (item.toolCalls.length > 5) return null;
        const calls: ChatToolCall[] = [];
        for (const tc of item.toolCalls) {
          if (!isPlainObject(tc)) return null;
          const fn = tc.function;
          if (!isPlainObject(fn) || typeof fn.name !== "string") return null;
          if (typeof fn.arguments !== "string" && !isPlainObject(fn.arguments)) return null;
          const id = typeof tc.id === "string" ? tc.id : `tc-${out.length}-${calls.length}`;
          calls.push({ id, type: typeof tc.type === "string" ? tc.type : "function", function: { name: fn.name, arguments: fn.arguments } });
          pendingToolIds.add(id);
        }
        if (calls.length) msg.toolCalls = calls;
      }
      out.push(msg);
      continue;
    }
    // role === "tool"
    const toolCallId = item.toolCallId;
    if (typeof content !== "string" || content.length > 20000) return null;
    if (typeof toolCallId !== "string" || !pendingToolIds.has(toolCallId)) continue; // orphelin -> supprimé
    out.push({ role: "tool", content, toolCallId });
  }
  return out;
}

export const CHAT_SYSTEM_PREFIX = [
  "Tu es un assistant conversationnel francophone.",
  "Quand la question porte sur des données des bases (personnes, voeux, enseignements, structure de l'établissement...),",
  "interroge-les en lecture seule via l'outil run_readonly_sql (paramètre database = nom de la source).",
  "Tu peux enchaîner plusieurs appels d'outil ; les résultats des appels précédents sont dans l'historique :",
  "utilise-les comme contexte (ex: après avoir trouvé des personnes, réutilise leurs identifiants dans la requête suivante).",
  "Quand tu as assez d'informations, réponds en français, en citant les chiffres exacts, sans appeler d'outil.",
  "Ne fabrique jamais de données : si une information n'est pas dans les résultats d'outils, dis-le.",
].join("\n");

export interface ChatResult {
  reply: string;
  steps: AskStep[];
  /** Messages à ajouter à l'historique client (assistant avec toolCalls, tool, assistant final). */
  append: ChatMessage[];
}

export interface RunChatOpts {
  model: string;
  maxToolRounds: number;
}

/**
 * Boucle de chat : si nl2sql est fourni, les outils SQL sont exposés au modèle
 * et exécutés (validés) côté serveur à chaque appel d'outil.
 */
export async function runChat(
  mistral: Mistral,
  nl2sql: Nl2Sql | null,
  rawMessages: unknown,
  opts: RunChatOpts
): Promise<ChatResult> {
  const history = sanitizeMessages(rawMessages);
  if (!history) {
    throw new ChatBadRequestError("Corps attendu : { messages: [{ role, content }] }");
  }

  // Sans source NL2SQL configurée : chat simple, sans outils
  if (!nl2sql) {
    const completion = await mistral.chat.complete({ model: opts.model, messages: history as never });
    const reply = contentToText(completion.choices?.[0]?.message?.content);
    return { reply, steps: [], append: [{ role: "assistant", content: reply }] };
  }

  const system = {
    role: "system",
    content: CHAT_SYSTEM_PREFIX + "\n\n" + (await nl2sql.buildSystemPrompt()),
  };
  const all: unknown[] = [system, ...history.filter((m) => m.role !== "system")];
  const append: ChatMessage[] = [];
  const steps: AskStep[] = [];

  let rounds = 0;
  while (rounds < opts.maxToolRounds) {
    rounds++;
    const completion = await mistral.chat.complete({
      model: opts.model,
      messages: all as never,
      tools: [nl2sql.sqlTool],
      toolChoice: "auto",
    });
    const message = completion.choices?.[0]?.message;
    const asMsg = message as unknown as ChatMessage;
    all.push(message);
    append.push(asMsg);

    const toolCalls = (message?.toolCalls ?? []) as ToolCallLike[];
    if (toolCalls.length === 0) {
      return { reply: contentToText(message?.content) || "", steps, append };
    }
    for (const call of toolCalls) {
      const { step, payload } = await nl2sql.executeCall(call);
      steps.push(step);
      const toolMsg: ChatMessage = { role: "tool", content: payload, toolCallId: call.id ?? `call-${steps.length}` };
      all.push(toolMsg);
      append.push(toolMsg);
    }
  }

  // Rounds épuisés : synthèse finale à partir de l'historique (dont résultats d'outils)
  const fin = await mistral.chat.complete({
    model: opts.model,
    messages: [
      ...(all as never[]),
      { role: "user", content: "Réponds maintenant en français, sans appeler d'outil, à partir de la conversation." },
    ] as never,
  });
  const fm = fin.choices?.[0]?.message as unknown as ChatMessage;
  append.push(fm);
  return { reply: contentToText(fin.choices?.[0]?.message?.content) || "", steps, append };
}
