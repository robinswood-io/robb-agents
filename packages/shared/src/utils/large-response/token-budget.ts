
// ============================================================
// Constants (re-exported from summarize.ts for convenience)
// ============================================================

/**
 * Default per-result summarization threshold (roughly ~16KB of plain text,
 * less for token-dense content like base64).
 *
 * Prefer {@link tokenLimitFor} at call sites that have the active model's
 * `contextWindow` available — model-aware sizing keeps moderate-context
 * models (e.g. 64k) from filling their window with a few sub-threshold tool
 * results that each pass individually.
 *
 * Cost-control default: one tool result may consume at most ~4% of the
 * 100k active-context budget. Full output is retained as a durable artifact;
 * only the reference and summary remain in model context.
 */
export const TOKEN_LIMIT = 4_000;

/** Max tokens sent to the mini summarizer. Beyond this, save + preview only. */
export const MAX_SUMMARIZATION_INPUT = 40_000;

/** Canonical subfolder under session dir for full tool results */
export const LONG_RESPONSES_DIR = 'long_responses';

/**
 * Floor for the model-aware per-result threshold. Below this size the
 * file-reference + summary message is roughly the same size as the original
 * content, so summarization stops paying off.
 */
const TOKEN_LIMIT_FLOOR = 1_000;

/** Fraction of the model's context window allocated to a single tool result
 *  before we summarize. The global 4k ceiling protects large-window models. */
const PER_RESULT_CONTEXT_FRACTION = 0.04;

// ============================================================
// Token Estimation
// ============================================================

/**
 * Estimate token count from text length (rough approximation: 4 chars per token)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Threshold above which base64-density correction kicks in. Below this size
 * the correction doesn't matter — the result fits anyway.
 */
const DENSITY_AWARE_MIN_LENGTH = 20_000;

/** Minimum run length for a base64-dense span to count. Set to 60 to catch
 *  the common wrapping styles for line-broken base64 in the wild — RFC 2045
 *  MIME wraps at 76, PEM at 64, custom encoders sometimes 60. Short
 *  alphanumeric runs (URLs without `:/?&`, UUIDs, identifiers) sit below
 *  this threshold so the false-positive rate stays low.
 *
 *  Hex digests (SHA-256 = 64 chars, SHA-512 = 128) and JWTs do match — both
 *  are token-dense in real tokenizers, so a tool result dominated by them
 *  should spill anyway. */
const BASE64_RUN_MIN = 60;

/** Fraction of total characters that must be inside long base64-style runs
 *  before the density correction applies. */
const BASE64_DENSITY_THRESHOLD = 0.70;

/** Effective chars-per-token for base64 in real tokenizers (Anthropic, GPT,
 *  Llama all land in the 1.3–1.7 range for base64-heavy content). */
const BASE64_CHARS_PER_TOKEN = 1.5;

/**
 * Density-aware token estimate. Mirrors {@link estimateTokens} for normal
 * text but corrects for base64-heavy content (email MIME bodies, JSON with
 * embedded binary, dumped certs, etc.) where the 4-chars/token heuristic
 * underestimates by ~2.5x.
 *
 * Trigger conditions (all must hold):
 *  - text length ≥ {@link DENSITY_AWARE_MIN_LENGTH}
 *  - ≥ {@link BASE64_DENSITY_THRESHOLD} of chars are inside unbroken
 *    base64-charset runs of length ≥ {@link BASE64_RUN_MIN}
 *
 * When triggered, returns `text.length / 1.5` instead of `text.length / 4`.
 */
export function estimateTokensDensityAware(text: string): number {
  if (text.length < DENSITY_AWARE_MIN_LENGTH) return estimateTokens(text);
  const runRegex = new RegExp(`[A-Za-z0-9+/=]{${BASE64_RUN_MIN},}`, 'g');
  let denseChars = 0;
  for (const match of text.matchAll(runRegex)) {
    denseChars += match[0].length;
  }
  if (denseChars / text.length >= BASE64_DENSITY_THRESHOLD) {
    return Math.ceil(text.length / BASE64_CHARS_PER_TOKEN);
  }
  return estimateTokens(text);
}

/**
 * Per-result summarization threshold scaled to the active model's context
 * window. A 200k-window model returns the {@link TOKEN_LIMIT} cap (4k);
 * a 64k-window model also returns 2_560; below ~25k window the floor (1_000)
 * kicks in.
 *
 * Pass `undefined` when the call site has no model context — returns the
 * fixed default for backward compatibility.
 */
export function tokenLimitFor(contextWindow: number | undefined): number {
  if (!contextWindow || contextWindow <= 0) return TOKEN_LIMIT;
  return Math.max(
    TOKEN_LIMIT_FLOOR,
    Math.min(TOKEN_LIMIT, Math.floor(contextWindow * PER_RESULT_CONTEXT_FRACTION)),
  );
}
