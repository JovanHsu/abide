/** Jev, called directly with a TypeSafe key, or through the Vercel AI Gateway with a gateway key. */
export const TYPESAFE_MODEL_ID = "jev-latest";
export const GATEWAY_MODEL_ID = "typesafe-ai/jev";
export const TYPESAFE_KEY_ENV = "TYPESAFE_AI_API_KEY";
export const GATEWAY_KEY_ENV = "AI_GATEWAY_API_KEY";

/** Point the direct TypeSafe call at a self-hosted, API-compatible endpoint instead of typesafe.ai. */
export const TYPESAFE_BASE_URL_ENV = "TYPESAFE_AI_BASE_URL";

/**
 * OpenRouter serves Jev too, so the questions stay typed and the probabilities
 * stay calibrated — it is the same model answering, reached through a different
 * door. Only the URL differs, and the SDK's fetch is rewritten to carry it.
 */
export const OPENROUTER_KEY_ENV = "OPENROUTER_API_KEY";
export const OPENROUTER_MODEL_ENV = "OPENROUTER_MODEL";
export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
/**
 * Jev is a decision model, so OpenRouter serves it on a decisions endpoint
 * rather than chat completions: posting it to /chat/completions is refused with
 * "is a decisions model and cannot be used with the chat/completions endpoint".
 * The body is the same typed question set /systemone takes, which is why the
 * SDK can be pointed here by rewriting only the URL.
 */
export const OPENROUTER_DECISIONS_PATH = `${OPENROUTER_DEFAULT_BASE_URL}/systemone`;
export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const OPENROUTER_DEFAULT_MODEL_ID = "typesafe/jev-1.13";

/** List price observed 2026-09-17: $0.042 per million input tokens, output free. */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

/**
 * How long one group of rules may spend at the model before the edit is left
 * unjudged.
 *
 * Sized against the whole call, because latency scales with how many rules ride
 * in it: three rules answered in 2.7s, the twenty-six this repository's edit
 * phase actually sends ranged from 4.6s to 19.9s across identical prompts. The
 * spread is the provider's, not the prompt's, so the budget has to clear the
 * tail rather than the median.
 *
 * It stays under the 18s the hook allows itself, because that budget exits
 * silently: a check that runs past it produces no verdict at all, where one
 * that stops here at least reports that the change went unjudged.
 */
export const EDIT_CHECK_TIMEOUT_MS = 16_000;
/**
 * A turn carries every file the agent touched, so its one call is far heavier
 * than an edit's: the same 26 rules that answered in 8.7s on a single hunk took
 * 21s and 33s on a turn-sized diff. Stop also spends up to STOP_GIT_TIMEOUT_MS
 * (8s) and STOP_FALLBACK_DIFF_TIMEOUT_MS (6s) before the check, and gives
 * itself 70s, so this is what is left with room for the tail.
 */
export const TURN_CHECK_TIMEOUT_MS = 48_000;
export const STDIN_TIMEOUT_MS = 2_000;

/** Largest diff sent as state. Beyond this the diff is cut and marked. */
export const MAX_STATE_CHARS = 24_000;
export const MAX_TASK_CHARS = 600;

/** How many times one rule may block the same file within one turn before it only flags. */
export const MAX_BLOCKS_PER_RULE_PER_TURN = 2;
/** How many Stop checks one turn gets: the first, plus one re-check after a repair. */
export const MAX_STOP_CHECKS_PER_TURN = 2;

export const SESSION_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a single git call may run before it is killed. Well under every hook budget. */
export const GIT_TIMEOUT_MS = 5_000;
/** How long turn-start may spend snapshotting the working tree with git, all calls together. */
export const TURN_START_TIMEOUT_MS = 5_000;
/** How long Stop may spend on its own snapshot and the diff against the baseline. */
export const STOP_GIT_TIMEOUT_MS = 8_000;

/** How long computing one diff may take. Past this the check is skipped and logged rather than the hook held. */
export const DIFF_TIMEOUT_MS = 2_000;
/** Largest before-plus-after text a diff is attempted on at all. */
export const MAX_DIFF_INPUT_CHARS = 1_000_000;
/** Past this a file counts as unreadable. */
export const MAX_FILE_READ_BYTES = 16 * 1024 * 1024;
/** How long Stop's per-file fallback may spend on all of its diffs together. */
export const STOP_FALLBACK_DIFF_TIMEOUT_MS = 6_000;
