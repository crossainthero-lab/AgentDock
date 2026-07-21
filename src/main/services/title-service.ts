// Deterministic, local, no-model-call title extraction — never a paid AI
// request. Turns a user's own first prompt into a short topic label instead
// of the generic "New <Agent> session" placeholder. Intentionally simple and
// honest: it shortens/cleans the user's own words, it never invents or
// paraphrases new ones, so it can never claim a topic the prompt didn't
// actually state.
const FILLER_PREFIX =
  /^(please\s+|can you\s+|could you\s+|would you\s+|will you\s+|i want you to\s+|i need you to\s+|i'd like you to\s+|help me\s+|hey[,!]?\s+|hi[,!]?\s+)+/i

const MAX_WORDS = 7
const MAX_CHARS = 60

export const UNTITLED_CONVERSATION = 'Untitled conversation'
const CONTINUED_SUFFIX = ' (continued)'

/** Extracts a ~3-7 word topic title from the first meaningful line of a
 *  prompt. Returns null (never a placeholder string) when nothing
 *  meaningful can be safely extracted — callers decide their own fallback
 *  (UNTITLED_CONVERSATION, or reusing an earlier title) rather than this
 *  function guessing one. */
export function deriveTitleFromPrompt(prompt: string): string | null {
  const firstLine = prompt
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!firstLine) return null

  let text = firstLine.replace(FILLER_PREFIX, '')
  text = text.replace(/[?!.]+$/, '').trim()
  if (!text) return null

  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return null

  let title = words.slice(0, MAX_WORDS).join(' ')
  if (title.length > MAX_CHARS) title = `${title.slice(0, MAX_CHARS - 1).trimEnd()}…`
  title = title.charAt(0).toUpperCase() + title.slice(1)

  // Degenerate result guard — e.g. the whole line was punctuation/filler
  // ("???", "please") and nothing substantive survived stripping.
  const meaningfulChars = title.replace(/[^a-zA-Z0-9]/g, '')
  if (meaningfulChars.length < 3) return null

  return title
}

export function withContinuedSuffix(title: string): string {
  return `${title}${CONTINUED_SUFFIX}`
}

export function stripContinuedSuffix(title: string): string {
  return title.endsWith(CONTINUED_SUFFIX) ? title.slice(0, -CONTINUED_SUFFIX.length).trim() : title
}

const GENERIC_TITLE_PATTERN = /^New (Claude Code|Codex|Antigravity) session$/

export function isGenericDefaultTitle(title: string): boolean {
  return GENERIC_TITLE_PATTERN.test(title.trim())
}
