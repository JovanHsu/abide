// OpenRouter is not a TypeSafe endpoint: it has no /systemone, no typed
// questions and no calibrated probabilities. It speaks chat completions, so a
// question set has to be rendered into a prompt and the prose reply parsed back
// into the same answer shape the SDK returns. Everything downstream of
// evaluationTarget is unchanged; only the transport differs.

import { AbideError, type Question } from "@coldtea/abide-schema";
import {
  OPENROUTER_CHAT_PATH,
  OPENROUTER_DEFAULT_BASE_URL,
  OPENROUTER_MODEL_ENV,
  OPENROUTER_REPLY_ATTEMPTS,
} from "./constants.js";

/** The shape `toAnswer` in jev.ts expects, per question type. */
type RawAnswer =
  | { type: "boolean"; probability: number }
  | { type: "choice"; choice: string; probabilities?: Record<string, number> }
  | { type: "score"; score: number; probabilities?: Record<string, number> };

export type OpenRouterResult = {
  answers: Record<string, RawAnswer>;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
};

const SYSTEM = `You are a strict rule checker. You are given a change (a diff) and a set of questions, one per rule. Answer each question independently, using only the rule's text, its criteria and the change itself. You never see the conversation and must not assume anything about intent beyond the diff. Every answer carries a probability distribution over that question's own options.`;

const isBoolean = (q: Question): q is Extract<Question, { type: "boolean" }> =>
  q.type === "boolean";

const renderQuestion = (id: string, q: Question): string => {
  if (isBoolean(q)) {
    return [
      `Question "${id}" (boolean): ${q.instructions}`,
      q.criteria?.true === undefined ? "" : `  "true" means: ${q.criteria.true}`,
      q.criteria?.false === undefined ? "" : `  "false" means: ${q.criteria.false}`,
      `  Options, use these exact keys: "true" and "false".`,
      `  Answer with a probability for each, summing to 1. Near 1 for "true" means the rule is broken.`,
    ]
      .filter((line) => line !== "")
      .join("\n");
  }
  if (q.type === "choice") {
    const names = Object.keys(q.criteria);
    return [
      `Question "${id}" (choice): ${q.instructions}`,
      ...names.map((name, i) => `  ${i + 1}. "${name}": ${q.criteria[name]}`),
      `  Options, use these exact keys: ${names.map((n) => `"${n}"`).join(", ")}.`,
      `  Answer with a probability for each option, summing to 1.`,
    ].join("\n");
  }
  return [
    `Question "${id}" (score): ${q.instructions}`,
    ...q.criteria.map((desc, i) => `  ${i}. ${desc}`),
    `  Options, use these exact keys: ${q.criteria.map((_, i) => `"${i}"`).join(", ")} (level 0 is best, ${q.criteria.length - 1} is worst).`,
    `  Answer with a probability for each level, summing to 1.`,
  ].join("\n");
};

/** The skeleton pins the keys, so a drifting model still answers in the right shape. */
const answerShape = (q: Question): Record<string, unknown> => {
  if (isBoolean(q))
    return { true: 0, false: 0, note: "probability of each, summing to 1" };
  if (q.type === "choice")
    return { probabilities: { "<each option name>": 0 }, note: "one entry per option, summing to 1" };
  return {
    probabilities: { "<each level index>": 0 },
    note: "one entry per level index, summing to 1",
  };
};

export type OpenRouterState = {
  task?: string;
  file?: string;
  files?: string[];
  diff: string;
};

const buildPrompt = (state: OpenRouterState, questions: Record<string, Question>): string => {
  const parts: string[] = [];
  if (state.task !== undefined)
    parts.push(`The user's request for this turn:\n${state.task}`);
  if (state.file !== undefined) parts.push(`File: ${state.file}`);
  else if (state.files !== undefined) parts.push(`Files: ${state.files.join(", ")}`);
  parts.push(`The change:\n\`\`\`diff\n${state.diff}\n\`\`\``);
  parts.push(
    "Questions:\n" +
      Object.entries(questions)
        .map(([id, q]) => renderQuestion(id, q))
        .join("\n\n"),
  );
  const skeleton = Object.fromEntries(
    Object.entries(questions).map(([id, q]) => [id, answerShape(q)]),
  );
  parts.push(
    `Reply with ONLY a JSON object, no prose, no code fence. Exactly one key per question id, in the shape of this skeleton (values replaced):\n${JSON.stringify(skeleton)}`,
  );
  return parts.join("\n\n");
};

const stripFence = (text: string): string => {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  // Some models wrap the object in a sentence; keep the outermost braces.
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start !== -1 && end > start ? body.slice(start, end + 1) : body;
};

const firstNumber = (obj: unknown, keys: readonly (string | number)[]): number | undefined => {
  if (typeof obj !== "object" || obj === null) return undefined;
  const record: Record<string, unknown> = { ...obj };
  for (const key of keys) {
    const value = record[String(key)];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))
      return Number(value);
  }
  return undefined;
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Coerce a model's reply into the answer shape. A model drifts: it invents
 * option names, returns a bare score instead of a distribution, or answers a
 * boolean as {"probabilities":{"yes":...}}. What matters is where the mass
 * sits, so it is read from wherever it landed, and a reply that cannot be read
 * at all is left out rather than guessed at — jev.ts skips a missing answer.
 */
const normalizeOne = (q: Question, answer: unknown): RawAnswer | undefined => {
  if (typeof answer !== "object" || answer === null) return undefined;
  const record: Record<string, unknown> = { ...answer };

  if (isBoolean(q)) {
    let p = firstNumber(record, ["probability", "noul", "score", "value", "confidence", "p", "true"]);
    if (typeof record.probabilities === "object" && record.probabilities !== null) {
      const fromDistribution = firstNumber(record.probabilities, ["true", "True", "TRUE", "yes"]);
      if (fromDistribution !== undefined) p = fromDistribution;
    }
    if (p === undefined) {
      if (typeof record.answer === "boolean") p = record.answer ? 1 : 0;
      else if (typeof record.answer === "string")
        p = /^(true|yes)$/i.test(record.answer) ? 1 : /^(false|no)$/i.test(record.answer) ? 0 : undefined;
    }
    return p === undefined ? undefined : { type: "boolean", probability: clamp01(p) };
  }

  if (q.type === "choice") {
    const names = Object.keys(q.criteria);
    const probabilities: Record<string, number> = {};
    for (const name of names) {
      const v = firstNumber(
        typeof record.probabilities === "object" && record.probabilities !== null
          ? record.probabilities
          : {},
        [name],
      );
      probabilities[name] = v === undefined ? 0 : clamp01(v);
    }
    const sum = Object.values(probabilities).reduce((s, v) => s + v, 0);
    if (sum > 0) return { type: "choice", choice: names[0] ?? "", probabilities };
    const picked = typeof record.choice === "string" ? record.choice : undefined;
    if (picked !== undefined && names.includes(picked))
      return { type: "choice", choice: picked, probabilities: { [picked]: 1 } };
    return undefined;
  }

  // score: a distribution over the levels is enough; the argmax is the level meant.
  const probabilities: Record<string, number> = {};
  let best = -1;
  let bestMass = -1;
  const distribution =
    typeof record.probabilities === "object" && record.probabilities !== null
      ? record.probabilities
      : {};
  q.criteria.forEach((_, i) => {
    const v = firstNumber(distribution, [i, String(i)]);
    const mass = v === undefined ? 0 : clamp01(v);
    probabilities[String(i)] = mass;
    if (mass > bestMass) {
      bestMass = mass;
      best = i;
    }
  });
  const top = firstNumber(record, ["score"]);
  const chosen = top !== undefined ? Math.round(top) : best;
  if (chosen < 0 || chosen >= q.criteria.length) return undefined;
  const hasDistribution = Object.values(probabilities).some((v) => v > 0);
  if (!hasDistribution) probabilities[String(chosen)] = 1;
  return { type: "score", score: chosen, probabilities };
};

const normalizeAll = (
  questions: Record<string, Question>,
  raw: unknown,
): Record<string, RawAnswer> => {
  const out: Record<string, RawAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const source =
      typeof raw === "object" && raw !== null ? { ...raw } as Record<string, unknown> : {};
    const answer = normalizeOne(question, source[id]);
    if (answer !== undefined) out[id] = answer;
  }
  return out;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One chat completion carrying every rule in the group. Retried on a reply that
 * will not parse, because a model that answered in prose answered the wrong
 * question and the next sample is cheaper than a missed violation.
 */
export const evaluateWithOpenRouter = async (options: {
  apiKey: string;
  baseURL: string;
  modelId: string;
  state: OpenRouterState;
  questions: Record<string, Question>;
  timeoutMs: number;
}): Promise<OpenRouterResult> => {
  const { apiKey, baseURL, modelId, state, questions, timeoutMs } = options;
  const url = `${baseURL}${OPENROUTER_CHAT_PATH}`;
  const prompt = buildPrompt(state, questions);
  let lastError: string = "no attempt was made";

  for (let attempt = 1; attempt <= OPENROUTER_REPLY_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await sleep(150 * (attempt - 1));
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: prompt },
          ],
          response_format: { type: "json_object" },
          temperature: 0,
          max_tokens: 2000,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError =
        error instanceof Error && error.name === "TimeoutError"
          ? "the model did not answer within the time allowed"
          : `the request failed: ${error instanceof Error ? error.message : String(error)}`;
      continue;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status >= 500 && attempt < OPENROUTER_REPLY_ATTEMPTS) {
        lastError = `OpenRouter answered ${response.status}`;
        continue;
      }
      throw new AbideError(
        "CHECK_FAILED",
        `OpenRouter answered ${response.status}${text === "" ? "" : `: ${text.slice(0, 200)}`}`,
      );
    }

    const body = await response.json().catch(() => undefined);
    const content: unknown =
      typeof body === "object" && body !== null
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ((body as any)?.choices?.[0]?.message?.content as unknown)
        : undefined;
    if (typeof content !== "string" || content.trim() === "") {
      lastError = "the model returned no text";
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFence(content));
    } catch {
      lastError = "the model did not return JSON";
      continue;
    }

    const answers = normalizeAll(questions, parsed);
    // Every question unanswered is a wrong reply, not a set of clear verdicts.
    if (Object.keys(answers).length === 0) {
      lastError = "no answer could be read for any rule";
      continue;
    }

    const usage = typeof body === "object" && body !== null ? (body as { usage?: unknown }).usage : undefined;
    return {
      answers,
      inputTokens: firstNumber(usage, ["prompt_tokens", "input_tokens"]),
      outputTokens: firstNumber(usage, ["completion_tokens", "output_tokens"]),
    };
  }

  throw new AbideError("CHECK_FAILED", lastError);
};

export { OPENROUTER_DEFAULT_BASE_URL, OPENROUTER_MODEL_ENV };
