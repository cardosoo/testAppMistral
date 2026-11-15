import type { Mistral } from "@mistralai/mistralai";
import {
  contentToText,
  type AskStep,
  type Nl2Sql,
  type ToolCallLike,
} from "./nl2sql.ts";

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

/* ------------------------------------------------------------------ */
/* Bloc graphique ```chart : spec JSON produite par le modèle,       */
/* rendue côté navigateur en SVG (aucune exécution de code).          */
/* ------------------------------------------------------------------ */

export interface ChartSpec {
  type: "bar" | "line";
  /** "vertical" (défaut) ou "horizontal" (barres horizontales, uniquement pour bar). */
  orientation: "vertical" | "horizontal";
  title: string;
  labels: string[];
  values: number[];
  /** Couleur des barres / de la courbe (hex, rgb(), hsl() ou nom CSS). */
  color?: string;
  /** Palette par barre (répétée en boucle). */
  colors?: string[];
}

// Couleur CSS sûre : hex / rgb(a) / hsl(a) / nom simple (lettres uniquement).
// Jamais de quotes, parenthèses exotiques ou < > -> impossible d'injecter du SVG.
const COLOR_RE =
  /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*){2,3}\)|hsla?\(\s*[\d.]+(?:deg)?\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*(,\s*[\d.]+%?\s*)?\)|[a-zA-Z]{3,20})$/;

function cleanColor(c: unknown): string | undefined {
  if (typeof c !== "string") return undefined;
  const t = c.trim().slice(0, 40);
  return COLOR_RE.test(t) ? t : undefined;
}

function validateChart(raw: unknown): ChartSpec | null {
  if (!isPlainObject(raw)) return null;
  const type: "bar" | "line" = raw.type === "line" ? "line" : "bar";
  if (!Array.isArray(raw.labels) || !Array.isArray(raw.values)) return null;
  if (raw.labels.length === 0 || raw.labels.length > 100) return null;
  if (raw.labels.length !== raw.values.length) return null;
  const labels = raw.labels.map((l) => String(l).slice(0, 80));
  const values = raw.values.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : NaN));
  if (values.some((v) => Number.isNaN(v))) return null;
  const out: ChartSpec = {
    type,
    orientation: type === "bar" && raw.orientation === "horizontal" ? "horizontal" : "vertical",
    title: String(raw.title ?? "").slice(0, 120),
    labels,
    values,
  };
  const color = cleanColor(raw.color);
  if (color) out.color = color;
  if (Array.isArray(raw.colors)) {
    const colors = raw.colors.map(cleanColor).filter((c): c is string => !!c).slice(0, 100);
    if (colors.length) out.colors = colors;
  }
  return out;
}

/**
 * Extrait un bloc ```chart {json} ``` du texte du modèle.
 * Retourne le graphique validé (ou null) et le texte nettoyé (bloc retiré).
 */
export function parseChartBlock(text: string): { chart: ChartSpec | null; text: string } {
  const m = text.match(/```chart\s*\r?\n([\s\S]*?)```/i);
  if (!m) return { chart: null, text };
  let chart: ChartSpec | null = null;
  try {
    chart = validateChart(JSON.parse(m[1]));
  } catch {
    chart = null;
  }
  return { chart, text: text.replace(m[0], "").trim() };
}

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
  "",
  "Graphiques : quand l'utilisateur demande un graphique (histogramme, courbe...), produis d'abord les données",
  "(outil SQL si nécessaire), puis inclus dans ta réponse un bloc ```chart contenant UNIQUEMENT un JSON :",
  '{"type":"bar"|"line","orientation":"vertical"|"horizontal","title":"...","color":"#4f46e5","colors":["..."],"labels":["..."],"values":[...]}',
  "- labels et values de même longueur, valeurs numériques finies, max 100 points ;",
  '- "orientation":"horizontal" uniquement pour un histogramme (barres horizontales) ;',
  '- "color" (couleur des barres/courbe : hex, rgb(), hsl() ou nom CSS comme "red") et/ou "colors" (palette par barre) sont optionnels ;',
  "  ex. barres rouges horizontales : {\"type\":\"bar\",\"orientation\":\"horizontal\",\"color\":\"red\",...}",
  "Le graphique sera rendu tel quel dans l'interface : ne produis pas de code Python/matplotlib, pas d'image, juste ce bloc JSON.",
].join("\n");

export interface ChatResult {
  reply: string;
  chart: ChartSpec | null;
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
    const { chart, text } = parseChartBlock(contentToText(completion.choices?.[0]?.message?.content));
    return { reply: text, chart, steps: [], append: [{ role: "assistant", content: text }] };
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
      const { chart, text } = parseChartBlock(contentToText(message?.content) || "");
      return { reply: text, chart, steps, append };
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
  const { chart, text } = parseChartBlock(contentToText(fin.choices?.[0]?.message?.content) || "");
  return { reply: text, chart, steps, append };
}
