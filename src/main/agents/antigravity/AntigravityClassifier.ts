// Antigravity classifier — rules below are grounded in real captured output
// from `agy` 1.1.1/1.1.2 (`-i <prompt>`), captured via a real node-pty
// session against this exact adapter's argv (see project history / plan
// notes), not guessed. Previously this classifier had no agent-specific
// rules at all and treated every new line as prose — real captures showed
// that dumps the entire startup banner (ASCII art, account email, model,
// workspace path), the echoed prompt, and the live "thinking" status
// straight into the chat alongside the actual reply. Real shape observed,
// twice, for two unrelated turns:
//
//   <ASCII art banner>
//   Antigravity CLI <version>
//   <email> (<plan>)
//   <model>
//   <workspace path>
//   ──── (separator)
//   > <echoed prompt>
//                                      -- all of the above: startup chrome,
//                                         shown exactly once, before the
//                                         first echoed prompt line ever
//                                         appears
//   ▸ Thought for Ns, N tokens        -- live "thinking" status (-> activity)
//     Prioritizing Tool Usage         -- a fixed reasoning-subtitle line
//                                         directly under the Thought line —
//                                         identical verbatim across two
//                                         unrelated real turns, so treated
//                                         as part of that same status, not
//                                         prose
//   ● <Verb>(<args>) (ctrl+o to expand) -- a real tool call (-> tool_activity)
//   ──── / > / ? for shortcuts ...    -- idle composer chrome after a reply
//
// CRITICAL architectural note (proven via real captured multi-turn, multi-
// interaction sessions gathered while investigating a reported turn-
// misattribution bug — see this file's git history for the exact captures):
// agy does NOT render as a simple append-only stream. It redraws parts of
// its own screen — including the echoed prompt, tool-call lines, and reply
// text, not just decorative chrome — via absolute cursor positioning
// (`\x1b[8;1H` etc.), sometimes into rows that a naive "only look at lines
// past however-far-we've-counted" watermark had already marked as
// processed. A simple monotonically-advancing line-count watermark
// (`processedLineCount`, the original design) is fundamentally unsound
// against this: it can permanently skip real content that gets redrawn into
// an already-counted row, and — because completion is ALSO detected against
// a fixed-position footer independent of that watermark — a turn can be
// marked complete while its own real reply/tool-call content was silently
// never classified at all.
//
// Fixed by re-scanning content two different ways, both driven by real,
// verifiable evidence rather than a forward-only position:
//  - The echo: independently re-scanned every snapshot (scanForTurnEcho),
//    bounded below by lastConsumedEchoIndex (the previous turn's own echo
//    position) rather than an ever-advancing count — see its doc comment.
//  - Everything else (prose/thought/tool-activity): the classifier re-scans
//    the ENTIRE current buffer on every snapshot once this turn's own echo
//    is known (emitContent is always called from index 0), relying on
//    turnEchoLineIndex to exclude anything before this turn's own content
//    and on classifiedLineContents (content-keyed, not index-keyed) to
//    avoid re-emitting a line already turned into an event.
import type { ClassifiedScreenEvent } from './classified-event'
import type { ScreenSnapshot } from '../../terminal/TerminalScreenBuffer'
import { detectAuthRequired, detectGenericInteraction, TAIL_WINDOW } from '../../terminal/TerminalInteractionDetector'

// Minimum time a turn must have been running before an idle-shaped footer
// is trusted as this turn's own completion, used only as a fallback when
// sawBusyThisTurn never fires (a turn that finishes faster than one
// debounce/snapshot cycle) — see AntigravityClassifier.sawBusyThisTurn's
// doc comment for why a hard busy-observed requirement isn't used instead.
const MIN_TURN_GRACE_MS = 800

const SEPARATOR_LINE = /^─+$/
const ECHO_LINE = /^>\s?/
const FOOTER_LINE = /^\?\s*for shortcuts\b/i
const THOUGHT_LINE = /^▸\s*Thought for (\d+)s/
const TOOL_ACTIVITY_LINE = /^●\s*([A-Za-z][\w]*)\(([^)]*)\)(?:\s*\(ctrl\+o to expand\))?\s*$/
// Real captured contrast, confirmed live: the status-bar footer reads
// "esc to cancel ... <model>" while a turn is in flight, and switches to
// "? for shortcuts" once agy is genuinely idle and ready for the next
// prompt — the only observed textual signal that distinguishes "done" from
// "still working" for a live (not-yet-exited) interactive session.
const IDLE_READY_FOOTER = /\?\s*for shortcuts\b/i
const BUSY_FOOTER = /esc to cancel\b/i
// The busy-state status line itself ("esc to cancel ... <model>") — real
// captured chrome that, unlike the idle footer above, was never suppressed
// from prose at all: nothing in the original suppression rules recognized
// it, so it could leak straight into an assistant message's text.
const BUSY_FOOTER_LINE = /esc to cancel\b.*$/i
// Real captured CSAT survey toast (appears unprompted, mid-session, unlike
// every other recognized shape here) — "[N] Label" bracket format, not the
// "N. Label" shape TerminalInteractionDetector's menus expect, so it was
// invisible to interaction detection too and would otherwise leak into the
// chat as if it were part of the model's own reply. Deliberately suppressed
// rather than auto-answered: there's no confirmed evidence it actually
// blocks input (it may self-dismiss), and sending an unprompted keystroke
// into a live conversation on unconfirmed behavior risks it being
// interpreted as real chat content instead.
const CSAT_SURVEY_LINE = /how'?s the cli experience so far|\[\d\]\s*(good|fine|bad|skip)\b/i
// CRITICAL (real bug fix, confirmed via a real captured multi-hop handoff
// session — see this file's git history / the investigation that produced
// this fix): agy's transient "Generating..." status text and its
// "▸ Thought Process" collapsed-thought heading can each end up glued
// directly onto the START of real reply text on the exact same rendered PTY
// row, with no separating newline at all (e.g. a real captured row read
// literally "...(failed 5 times)▸ Thought Process" with the real reply
// beginning immediately after it on the very next row). Neither is safe to
// filter as a whole-line match for that reason — matching only an exact,
// standalone line would leave the glued chrome sitting at the front of what
// then becomes the first line of the reply. Both are matched and stripped
// as a LEADING PREFIX instead (see stripLeadingChrome), keeping whatever
// real text follows on the same row. Deliberately narrow: "Generating"
// requires agy's own literal ellipsis-terminated status shape (ASCII "..."
// or the Unicode "…" agy has been observed to render), and "Thought
// Process" requires the same "▸" arrow marker THOUGHT_LINE's "Thought for
// Ns" already relies on as an unambiguous chrome signal — neither pattern
// matches ordinary prose that merely contains those words (e.g. "Generating
// a random UUID" or "My thought process here" never match — no literal
// ellipsis/arrow immediately follows "Generating"/precedes "Thought
// Process" in either).
const GENERATING_PREFIX = /^Generating(?:\.\.\.|…)+\s*/i
const THOUGHT_PROCESS_ARROW_PREFIX = /^▸\s*Thought Process\s*/i
// The same heading with no leading "▸" arrow (real captured shape: agy
// sometimes redraws it as a bare standalone line) — matched only as a WHOLE
// line, never a prefix, specifically so genuine prose that happens to
// start a line with the words "Thought Process" (e.g. "Thought Process:
// I decided to use localStorage...") is never touched; only a line with
// NOTHING else on it is agy's own chrome.
const THOUGHT_PROCESS_BARE_LINE = /^Thought Process$/i
// CRITICAL (real bug fix): the fixed reasoning-subtitle line normally
// swallowed via expectingThoughtLabel's one-shot "skip the next line" state
// (see its doc comment) — that mechanism only fires when this line
// immediately follows its own Thought line within the SAME re-scanned
// range; a real captured multi-turn session showed it can also surface on
// its own (its trigger Thought line already consumed by an earlier
// snapshot's expectingThoughtLabel reset), leaking as if it were real reply
// text. Matched directly here too — belt and suspenders, since it's a fixed
// status string, never genuine model output.
const THOUGHT_SUBTITLE_LINE = /^Prioritizing Tool Usage$/i
// CRITICAL (real bug fix, found via a real captured process-exit sequence):
// agy prints its own graceful-shutdown chrome ("Resume with -c (or command
// below): / agy --conversation=<uuid>") to the screen when the process
// exits — TerminalSessionController's onExit handler emits one final
// snapshot (see its own module comment) that includes this text if it was
// already written by the time the process died. Without this filter, that
// chrome got classified as ordinary prose and appended straight onto the
// turn's real accumulated reply (confirmed live: "...successfully created
// the file.\nResume with -c (or command below):\nagy --conversation=..."),
// since content-keyed dedup only skips lines already seen, never lines that
// are simply not part of the conversation at all.
const RESUME_COMMAND_LINE = /^Resume with -c\b|^agy --conversation=/i
// Animated braille spinner glyphs — the same character set the existing,
// real-captured auth-screen spinner ("⣾  Signing in...") already
// demonstrates agy uses for transient in-progress indicators (see
// detectAuthRequired's own doc comment for that specific capture). Like
// GENERATING_PREFIX/THOUGHT_PROCESS_ARROW_PREFIX, matched as a leading
// PREFIX rather than a whole-line pattern: a spinner glyph is exactly the
// kind of transient decoration that can sit directly in front of real
// content the instant it resolves, on the very same row, the same class of
// glued-chrome shape this file's other prefixes exist to handle.
const SPINNER_PREFIX = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]+\s*/
// A bare elapsed-time readout with nothing else on the row (e.g. a status
// area showing just "12s" or "1m 04s" while idle-adjacent to a spinner) —
// exact whole-line match only, deliberately never a prefix, so real prose
// that happens to mention a duration (e.g. "This took about 12s to run.")
// is never touched.
const ELAPSED_TIME_LINE = /^\d+(?:m\s*\d+)?s$/i

// CRITICAL (real bug fix — proven via static analysis of real captured agy
// screen sequences gathered during this investigation): the old
// `ECHO_LINE = /^>\s?/` "have we seen the real prompt echoed yet" gate
// matched ANY line starting with ">", including agy's persistent, always-
// present EMPTY composer-box chrome line (shown the instant agy reaches its
// main interactive screen, independent of whether the real prompt's own
// echo has rendered above it yet). That let the "ignore startup chrome"
// gate open on a line carrying no real content at all — so leftover/
// onboarding/greeting text appearing between that bare box and the real
// echoed prompt could be misclassified as the assistant's genuine reply to
// the user's actual request. Worse, the old flag was process-lifetime
// (reset() only, never per-turn) — on a REUSED process (turn 2+) there was
// no "ignore chrome until THIS turn's own prompt is echoed" protection at
// all, so any chrome re-drawn between beginTurn() and the real per-turn
// echo (agy does redraw its fixed banner/chrome on screen transitions —
// confirmed via real capture) had nothing filtering it out, and could leak
// through as if it were new prose for that turn.
//
// Fixed by requiring an echo candidate to actually start with (a prefix of)
// the exact prompt just sent for THIS turn, and by making the gate
// turn-scoped (reset every beginTurn(), not just once per process) — every
// turn now suppresses all content until its own real prompt has genuinely
// been echoed back, the same protection turn 1 always had, applied
// uniformly to every later turn on a reused process too.
// CRITICAL (real bug fix, proven via a real captured Codex -> Antigravity
// handoff session): agy's own rendering of pasted text can DROP certain
// "smart"/typographic Unicode punctuation entirely rather than displaying it
// (or any substitute) — confirmed live: a session title auto-derived from
// natural-language text containing a curly apostrophe ("Claude’s existing
// FocusBoard project") rendered on screen as "Claudes existing FocusBoard
// project" — the apostrophe simply gone, not even a blank glyph left in its
// place. Left unhandled, that single missing character was enough to break
// the exact-content echo match at exactly that point, misclassifying the
// ENTIRE REMAINDER of a long continuation prompt (workspace path, prior
// work, files changed — everything after it) as new assistant content, the
// very bug this file's echo-consumption logic exists to prevent. Stripped
// out — never required to match — on BOTH sides of every echo comparison in
// this file, alongside whitespace: curly single/double quotes, em/en
// dashes, and horizontal ellipsis are the "smart typography" characters
// most likely to appear in auto-generated text (titles, summaries) and
// least likely to survive a terminal's own glyph rendering unchanged.
const DROPPABLE_PUNCTUATION = /[’‘“”—–…]/g
// A plain-string membership check for the same character set, used
// per-character in rawColumnAfterFlatPrefix below — deliberately NOT reusing
// DROPPABLE_PUNCTUATION's own `.test()` there: a global-flagged RegExp's
// `.test()` is stateful (it advances `lastIndex` across calls), which would
// silently skip every other match when called repeatedly in a loop like
// that one. `.replace()` (flattenForEchoMatch's own use, above) doesn't
// have this hazard — only a looped `.test()`/`.exec()` does.
const DROPPABLE_PUNCTUATION_CHARS = '’‘“”—–…'

/** Whitespace AND `DROPPABLE_PUNCTUATION` collapsed away — the shared
 *  normalization every echo comparison in this file goes through, so
 *  neither a soft line-wrap nor a terminal-dropped character can ever be
 *  the difference between "this is still the echo" and "this is new
 *  content". */
function flattenForEchoMatch(text: string): string {
  return text.replace(DROPPABLE_PUNCTUATION, '').replace(/\s+/g, '')
}

/** True if `candidateAfterArrow` (already stripped of a leading "> ") is
 *  consistent with being the (possibly visually-wrapped, possibly still
 *  mid-type) echo of `prompt`. Prefix-matches in the shorter direction so
 *  both a short candidate against a long prompt (early in a multi-line
 *  wrap) and a short prompt fully contained in a padded candidate line
 *  match correctly. */
function looksLikePromptEcho(candidateAfterArrow: string, prompt: string): boolean {
  const candidate = flattenForEchoMatch(candidateAfterArrow)
  const expected = flattenForEchoMatch(prompt)
  if (!candidate || !expected) return false
  const shorterLen = Math.min(candidate.length, expected.length)
  if (shorterLen === 0) return false
  return candidate.slice(0, shorterLen) === expected.slice(0, shorterLen)
}

/** Strips any recognized chrome prefix (see GENERATING_PREFIX/
 *  THOUGHT_PROCESS_ARROW_PREFIX's own doc comment) from the front of an
 *  already-trimmed line, leaving whatever real content follows it — used
 *  both for an ordinary content row and for the tail end of this turn's own
 *  echoed prompt, when real chrome/reply text is rendered glued directly
 *  onto that same row with no newline in between. A no-op (returns `text`
 *  unchanged) when neither prefix matches. */
function stripLeadingChrome(text: string): string {
  return text.replace(GENERATING_PREFIX, '').replace(THOUGHT_PROCESS_ARROW_PREFIX, '').replace(SPINNER_PREFIX, '').trim()
}

/** Maps a length in `flattenForEchoMatch(raw)` terms back to a real
 *  character offset into `raw` itself — the column immediately after the
 *  `flatLen`-th character that survives flattening (i.e. skipping both
 *  whitespace and DROPPABLE_PUNCTUATION, exactly as flattenForEchoMatch
 *  does, so the two stay in lockstep). Used to find exactly where, within a
 *  single screen row, this turn's echoed prompt text ends and whatever
 *  renders right after it (on that identical row, real captures show — no
 *  newline guaranteed) begins. */
function rawColumnAfterFlatPrefix(raw: string, flatLen: number): number {
  if (flatLen <= 0) return 0
  let count = 0
  for (let i = 0; i < raw.length; i++) {
    if (/\s/.test(raw[i]) || DROPPABLE_PUNCTUATION_CHARS.includes(raw[i])) continue
    count += 1
    if (count === flatLen) return i + 1
  }
  return raw.length
}

export class AntigravityClassifier {
  private activePromptKey: string | null = null
  private interactionCounter = 0
  /** Everything before this turn's own real echoed "> <prompt>" line is
   *  chrome (startup banner/account/model/cwd on turn 1; potentially
   *  leftover/redrawn chrome from the previous turn's idle screen on turn
   *  2+) — suppressed unconditionally rather than pattern-matched against
   *  specific known strings, since that would mean hardcoding real account/
   *  model text into source. Turn-scoped (see beginTurn()), not
   *  process-lifetime — every turn gets this same protection. */
  private sawTurnEcho = false
  /** The exact prompt text this turn was sent, used to verify a `>`-led
   *  line is genuinely this turn's own echo and not agy's unrelated,
   *  always-present empty composer-box chrome (which also starts with
   *  ">" but carries no prompt text at all). */
  private expectedPrompt = ''
  /** Absolute index of the MOST RECENTLY consumed turn's own echo —
   *  process-lifetime (not reset per turn), used only as scanForTurnEcho's
   *  lower bound. CRITICAL: this is intentionally NOT the same as "how much
   *  of the buffer has been scanned" (that approach broke against in-place
   *  redraws — see this file's module comment). It exists purely to stop a
   *  PRIOR turn's own echo (which can be byte-for-byte identical — e.g. the
   *  exact same prompt sent twice in a row, the reported bug's own
   *  scenario) from being mistaken for the CURRENT turn's echo, without
   *  needing to exclude any other content. If the buffer has since shrunk
   *  to at or below this index (a real captured behavior: agy does full
   *  screen clears between some turns), that old index provably can't exist
   *  in the current snapshot anymore, so the bound resets to 0 instead of
   *  wrongly refusing to ever match again. */
  private lastConsumedEchoIndex: number | null = null
  /** Absolute index (into the full `lines` buffer) where THIS turn's own
   *  echo was found, once sawTurnEcho is true — null until then. This is
   *  what emitContent actually gates on (see its doc comment); a plain
   *  boolean isn't enough since the echo can be found within the very same
   *  batch emitContent is about to process. */
  private turnEchoLineIndex: number | null = null
  /** Column offset into the row at `turnEchoLineIndex` where this turn's
   *  own echoed prompt text ends, when that row also carries real content
   *  immediately after it with no separating newline — null (the common
   *  case) when the echo's own last row has nothing else on it, in which
   *  case emitContent skips that whole row exactly as before. See
   *  scanForTurnEcho's doc comment for why this can happen: a real captured
   *  multi-hop handoff prompt's echoed text ran right up against agy's own
   *  "▸ Thought Process" heading on the very same rendered row. */
  private turnEchoSplitCol: number | null = null
  /** True once this turn's ENTIRE echoed prompt has been matched against
   *  the screen — as opposed to `sawTurnEcho`, which only means the anchor
   *  ("> " + the prompt's own first line) has been found. CRITICAL (real
   *  bug fix, proven via a real captured Codex -> Antigravity handoff with a
   *  genuinely long, multi-paragraph continuation prompt): consuming the
   *  echo used to happen in a single pass, the moment the anchor was found,
   *  then `sawTurnEcho` latched true and scanForTurnEcho never ran again for
   *  the rest of the turn. For a short prompt the whole echo is already on
   *  screen by the time any snapshot is stable enough to classify, so that
   *  was invisible in testing — but a long prompt's own tail can still be
   *  mid-render (agy hasn't finished laying out that big a paste yet) at the
   *  moment the FIRST idle-debounced snapshot fires. That first pass then
   *  consumed only as much of the echo as had rendered by then, and because
   *  nothing ever re-attempted consumption afterward, every later line of
   *  the SAME still-unconsumed echo was fed straight into emitContent as if
   *  it were the assistant's own reply — confirmed live: a real reply
   *  persisted with "Continuing from a Codex conversation (...). Prior work
   *  completed: ..." — the tail half of the delivered prompt — glued onto
   *  the front of it. Fixed by letting consumption resume on every
   *  subsequent scanForTurnEcho call (see consumedEchoFlat) until the whole
   *  prompt is accounted for, not just once. */
  private echoFullyConsumed = false
  /** Whitespace-stripped text of the echo matched SO FAR this turn — the
   *  running progress consumption resumes from on each call, once the
   *  anchor is found but before `echoFullyConsumed` (see its doc comment).
   *  Reset (to the anchor line's own content) the moment the anchor is
   *  found; otherwise only ever grows, matching the immediately-following
   *  portion of `expectedPrompt`. */
  private consumedEchoFlat = ''
  /** Trimmed content of every line already turned into a real event
   *  (prose/thought/tool-activity) so far — process-lifetime (not reset per
   *  turn). CRITICAL (real bug fix — see this file's module comment): since
   *  emitContent now re-scans the WHOLE buffer on every snapshot (bounded
   *  only by turnEchoLineIndex, not by any forward-advancing watermark),
   *  this content-keyed set is what stops that re-scan from re-emitting a
   *  line already classified — content-keyed rather than index-keyed
   *  specifically because the same real line can legitimately move to a
   *  different absolute index between snapshots (in-place redraw). Kept
   *  across turns rather than reset per turn because the SAME redraw
   *  problem can put a previous turn's already-classified content at an
   *  index that would otherwise look "new" to a later turn's re-scan; genuine
   *  replies are never byte-for-byte identical across turns in practice, so
   *  this carries negligible risk of hiding real new content, unlike the
   *  echo (which the reported bug proves absolutely can repeat verbatim —
   *  handled separately by lastConsumedEchoIndex instead). */
  private classifiedLineContents = new Set<string>()
  /** True right after emitting an `activity` for a "Thought for Ns" line —
   *  the very next non-blank line is that same status's fixed subtitle, not
   *  a real reply, so it's swallowed once rather than shown as prose. */
  private expectingThoughtLabel = false
  /** True once `turn_ready` has already been emitted for the turn currently
   *  in flight — without this, every subsequent idle snapshot (there can be
   *  many, since the screen stays unchanged while waiting for the next
   *  prompt) would re-emit it. Cleared by beginTurn(), not reset() — this is
   *  turn-scoped state, not process-lifetime state. */
  private turnReadySignaled = false
  /** True once the BUSY footer ("esc to cancel...") has been observed at
   *  least once since beginTurn() — real evidence agy has actually started
   *  working on THIS turn, not just that the screen happens to show an
   *  idle-shaped footer at the moment of a snapshot (which, immediately
   *  after a fresh spawn or right after answering an interaction, could
   *  still be showing state left over from before this turn genuinely
   *  began). Trusted immediately once true; see turnStartedAtMs for the
   *  fallback used when it never fires (a turn that completes faster than
   *  one debounce window, which real busy evidence would otherwise never
   *  catch — never a hard requirement, since that would risk hanging a
   *  turn forever if genuinely no busy snapshot ever lands). */
  private sawBusyThisTurn = false
  /** Wall-clock time beginTurn() was called — the minimum-elapsed-time
   *  fallback for the same "don't trust an idle footer that's actually
   *  leftover from before this turn began" problem sawBusyThisTurn targets,
   *  without the hang risk a hard busy-observed requirement would carry. */
  private turnStartedAtMs = 0
  /** CRITICAL (real bug fix, proven via a real live `--conversation` resume
   *  capture): true whenever a real prompt has actually been queued/written
   *  for this turn — in that case, elapsed time or a stale idle-shaped
   *  footer ALONE must never be enough to trust turn_ready; genuine evidence
   *  (this turn's own echo, or busy evidence) is required too. Real capture:
   *  resuming a conversation via `agy --conversation <id> -i <prompt>`
   *  redraws its idle composer shell (a footer matching IDLE_READY_FOOTER)
   *  before it has genuinely started processing the queued prompt — with
   *  only the elapsed-time fallback, that false-idle screen was
   *  indistinguishable from real completion, firing turn_ready instantly
   *  with zero real content classified, which then permanently blocked
   *  (turnReadySignaled) the turn's actual, later completion. False only for
   *  the bare-spawn attachment-bootstrap window (see AntigravityAdapter's
   *  pre-paste beginTurn call) — there, by construction, nothing has been
   *  written to the PTY yet, so no echo is possible and none should be
   *  required. */
  private requiresEcho = true

  reset(): void {
    this.activePromptKey = null
    this.sawTurnEcho = false
    this.expectedPrompt = ''
    this.lastConsumedEchoIndex = null
    this.turnEchoLineIndex = null
    this.turnEchoSplitCol = null
    this.echoFullyConsumed = false
    this.consumedEchoFlat = ''
    this.classifiedLineContents = new Set()
    this.expectingThoughtLabel = false
    this.turnReadySignaled = false
    this.sawBusyThisTurn = false
    this.turnStartedAtMs = 0
    this.requiresEcho = true
  }

  /** Call once per turn, right before writing the new prompt into the PTY.
   *  `prompt` is the exact text about to be sent — required so this turn's
   *  own echo can be told apart from unrelated chrome that also starts with
   *  ">" (see looksLikePromptEcho), and from a prior turn's own identical
   *  echo (see lastConsumedEchoIndex). Pass `requiresEcho: false` only for
   *  the bare-spawn attachment-bootstrap case (see requiresEcho's doc
   *  comment) — every other call site is a real prompt about to be written,
   *  which must keep the default. */
  beginTurn(prompt: string, options?: { requiresEcho?: boolean }): void {
    this.turnReadySignaled = false
    this.sawTurnEcho = false
    this.expectedPrompt = prompt
    this.turnEchoLineIndex = null
    this.turnEchoSplitCol = null
    this.echoFullyConsumed = false
    this.consumedEchoFlat = ''
    this.sawBusyThisTurn = false
    this.turnStartedAtMs = Date.now()
    this.requiresEcho = options?.requiresEcho ?? true
  }

  /** Independently re-scans on every snapshot until this turn's own echo is
   *  found — see this file's module comment for why a forward-advancing
   *  watermark can't be used here. Bounded below by lastConsumedEchoIndex
   *  (falling back to 0 if the buffer has since shrunk below it — see its
   *  doc comment) so a prior turn's own — possibly textually identical —
   *  echo is never mistaken for this turn's.
   *
   *  CRITICAL (real bug fix, proven via a real captured Codex -> Antigravity
   *  handoff session — see echoFullyConsumed's own doc comment for the full
   *  story): a long, multi-paragraph prompt's echo can still be PARTIALLY
   *  rendered — agy genuinely hasn't finished laying out that big a paste
   *  yet — at the moment the first idle-debounced snapshot is stable enough
   *  to classify. Consumption therefore RESUMES on every call (bounded by
   *  echoFullyConsumed, not a one-shot flag), continuing from
   *  consumedEchoFlat/turnEchoLineIndex's last position, until the entire
   *  expected prompt has genuinely been matched against the screen — not
   *  just once, whatever happened to be on screen the very first time an
   *  anchor was found.
   *
   *  Matched via flattenForEchoMatch against however much of the expected
   *  prompt hasn't been matched yet, so neither the prompt's own line breaks,
   *  the terminal's column-width soft-wrapping (which can split a single
   *  word across two rows — confirmed in a real capture:
   *  "...Get-ChildItem -\nForce'"), nor a character agy's own rendering
   *  dropped entirely (see DROPPABLE_PUNCTUATION's doc comment) affect the
   *  result. Consumption can end MID-ROW rather than only at a row boundary
   *  — a real capture's own boundary row read "...(failed 5 times)▸ Thought
   *  Process" with no separator between the prompt's last character and
   *  agy's own chrome — recorded via turnEchoSplitCol so emitContent can
   *  keep suppressing the echo half of that row while still processing
   *  whatever renders right after it. */
  private scanForTurnEcho(lines: string[]): void {
    const expectedFlat = flattenForEchoMatch(this.expectedPrompt)

    if (!this.sawTurnEcho) {
      const lowerBound =
        this.lastConsumedEchoIndex !== null && lines.length > this.lastConsumedEchoIndex ? this.lastConsumedEchoIndex + 1 : 0

      for (let i = lowerBound; i < lines.length; i++) {
        const trimmed = lines[i].trim()
        if (!ECHO_LINE.test(trimmed)) continue
        const afterArrow = trimmed.replace(ECHO_LINE, '')
        if (!looksLikePromptEcho(afterArrow, this.expectedPrompt)) continue

        this.sawTurnEcho = true
        this.turnEchoLineIndex = i
        this.turnEchoSplitCol = null
        this.lastConsumedEchoIndex = i
        this.consumedEchoFlat = flattenForEchoMatch(afterArrow)
        this.echoFullyConsumed = this.consumedEchoFlat.length >= expectedFlat.length
        break
      }
    }

    if (!this.sawTurnEcho || this.echoFullyConsumed || this.turnEchoLineIndex === null) return

    let j = this.turnEchoLineIndex + 1
    while (j < lines.length) {
      const remaining = expectedFlat.slice(this.consumedEchoFlat.length)
      if (remaining.length === 0) {
        this.echoFullyConsumed = true
        break
      }
      const candidateFlat = flattenForEchoMatch(lines[j])
      if (candidateFlat.length === 0) {
        // A blank row can legitimately appear inside the echo (one of the
        // prompt's own paragraph breaks) — consumed as a no-op.
        this.turnEchoLineIndex = j
        this.turnEchoSplitCol = null
        this.lastConsumedEchoIndex = j
        j += 1
        continue
      }
      if (remaining.startsWith(candidateFlat)) {
        // The whole row is still genuinely part of the echo; more remains.
        this.consumedEchoFlat += candidateFlat
        this.turnEchoLineIndex = j
        this.turnEchoSplitCol = null
        this.lastConsumedEchoIndex = j
        if (this.consumedEchoFlat.length >= expectedFlat.length) {
          this.echoFullyConsumed = true
          break
        }
        j += 1
        continue
      }
      if (candidateFlat.startsWith(remaining)) {
        // The prompt's own text ends partway through this row — real
        // content (chrome or the actual reply) begins immediately after it
        // on the same row, possibly with no separating whitespace.
        this.consumedEchoFlat = expectedFlat
        this.turnEchoLineIndex = j
        const cut = rawColumnAfterFlatPrefix(lines[j], remaining.length)
        this.turnEchoSplitCol = cut < lines[j].length ? cut : null
        this.lastConsumedEchoIndex = j
        this.echoFullyConsumed = true
      }
      // Either the split above just handled it, or this row doesn't
      // (yet — it may simply not have rendered completely yet) continue the
      // match — either way, stop for THIS call; a still-incomplete
      // consumption picks back up from here on the next classify() call.
      break
    }
  }

  classify(snapshot: ScreenSnapshot): ClassifiedScreenEvent[] {
    const { lines } = snapshot
    const events: ClassifiedScreenEvent[] = []

    const authMessage = detectAuthRequired(lines)
    if (authMessage) {
      events.push({ type: 'authentication_required', message: authMessage })
      return events
    }

    this.scanForTurnEcho(lines)

    // CRITICAL (real bug fix, proven via a real captured multi-interaction
    // session): must match TAIL_WINDOW exactly, the same window
    // detectGenericInteraction itself scans — this used to be a wider,
    // independently-hardcoded 30, silently discarding up to 16 lines of
    // genuine prose/tool-activity content that fell inside that mismatched
    // gap (chronologically just before a menu, but still within the
    // classifier's own wider exclusion zone) every time an interaction was
    // detected, with no later pass ever able to recover it.
    const tailStart = Math.max(0, lines.length - TAIL_WINDOW)
    const tail = lines.slice(tailStart)
    const guess = detectGenericInteraction(tail)
    if (guess) {
      // CRITICAL (real bug fix): excludes only up to the menu's own real
      // start (guess.menuStartIndex, absolute-indexed via tailStart), and
      // scans the WHOLE buffer up to that point (see this file's module
      // comment for why, and emitContent/classifiedLineContents for how
      // duplicates are avoided) rather than blindly the whole tail window
      // or an incremental watermark.
      const menuStart = tailStart + guess.menuStartIndex
      this.emitContent(lines.slice(0, menuStart), 0, events)

      const key = tail.join('\n')
      if (key !== this.activePromptKey) {
        this.activePromptKey = key
        this.interactionCounter += 1
        const interactionId = `antigravity-${this.interactionCounter}`
        if (guess.kind === 'permission') {
          events.push({ type: 'permission_required', interactionId, prompt: guess.prompt, options: guess.options })
        } else {
          events.push({ type: 'choice_required', interactionId, prompt: guess.prompt, options: guess.options })
        }
      }
      return events
    }
    this.activePromptKey = null

    // Re-scans the whole buffer every time — see this file's module comment
    // and classifiedLineContents' doc comment for why an incremental
    // watermark isn't safe against agy's in-place redraws.
    this.emitContent(lines, 0, events)

    // Checked against the live status-bar footer (last couple of rows),
    // independent of the scrollback-position bookkeeping above — this is a
    // fixed-position redraw, not scrollback content, and must be re-checked
    // every snapshot so the busy->idle transition is caught whichever
    // snapshot it lands in.
    const footerTail = lines.slice(-3).join('\n')
    const footerIsBusy = BUSY_FOOTER.test(footerTail)
    if (footerIsBusy) this.sawBusyThisTurn = true

    // CRITICAL (real bug fix): requires either real busy evidence or a
    // minimum grace period since this turn began — closes the premature-
    // completion window where an idle-shaped footer left over from BEFORE
    // this turn really started (e.g. immediately after a fresh spawn, or
    // right after answering an interaction, before agy has visibly picked
    // the prompt up yet) could otherwise be mistaken for this turn's own
    // completion.
    const turnHasRunLongEnough = this.sawBusyThisTurn || Date.now() - this.turnStartedAtMs >= MIN_TURN_GRACE_MS
    // CRITICAL (real bug fix, proven via a real live `--conversation` resume
    // capture — see requiresEcho's doc comment): when a real prompt is in
    // flight, the elapsed-time fallback above is not enough by itself —
    // resuming a conversation can redraw an idle-looking composer shell
    // before agy has genuinely started on the queued prompt, which the
    // time-only gate could not tell apart from real completion. Requires
    // this turn's own echo (or busy evidence) too in that case. Skipped
    // entirely (via requiresEcho: false) only for AntigravityAdapter's
    // bare-spawn attachment bootstrap, where nothing has been written to the
    // PTY yet, so no echo is possible or expected.
    const contentIsTrustworthy = !this.requiresEcho || this.sawTurnEcho || this.sawBusyThisTurn
    if (turnHasRunLongEnough && contentIsTrustworthy && !this.turnReadySignaled) {
      if (IDLE_READY_FOOTER.test(footerTail) && !footerIsBusy) {
        this.turnReadySignaled = true
        events.push({ type: 'turn_ready' })
      }
    }

    return events
  }

  /** `startIndex` is rawLines[0]'s absolute position in the full buffer —
   *  needed (not just the sawTurnEcho boolean) because the echo can be
   *  found WITHIN this very same batch (scanForTurnEcho runs first in
   *  classify(), before this): a plain boolean isn't enough to tell lines
   *  in *this* batch that come before the echo's own position apart from
   *  ones that come after it. */
  private emitContent(rawLines: string[], startIndex: number, events: ClassifiedScreenEvent[]): void {
    const proseLines: string[] = []
    const flushProse = (): void => {
      const text = proseLines.join('\n').trim()
      if (text) events.push({ type: 'assistant_message', text })
      proseLines.length = 0
    }

    for (let offset = 0; offset < rawLines.length; offset++) {
      const absoluteIndex = startIndex + offset

      // Chrome (startup banner on turn 1; potentially leftover/redrawn
      // chrome from the previous turn's idle screen on turn 2+) up to and
      // including this turn's own echoed prompt stays suppressed —
      // everything before turnEchoLineIndex, whether that's from an earlier
      // batch or this very one.
      if (this.turnEchoLineIndex === null || absoluteIndex < this.turnEchoLineIndex) continue

      // The row the echo itself ends on gets special handling: normally
      // (turnEchoSplitCol null) it's entirely echo, same as every row
      // before it. But see scanForTurnEcho's doc comment — real content can
      // render on this exact same row immediately after the echo's last
      // character, with no newline in between, in which case only the
      // portion from turnEchoSplitCol onward is genuinely new content.
      let effectiveLine = rawLines[offset]
      if (absoluteIndex === this.turnEchoLineIndex) {
        if (this.turnEchoSplitCol === null) continue
        effectiveLine = rawLines[offset].slice(this.turnEchoSplitCol)
      }

      // Chrome that can render glued directly onto the front of real
      // content on the same row (see GENERATING_PREFIX/
      // THOUGHT_PROCESS_ARROW_PREFIX's doc comment) is stripped before
      // anything else, so every check below sees only genuine content.
      const trimmed = stripLeadingChrome(effectiveLine.trim())

      if (trimmed === '') continue
      if (SEPARATOR_LINE.test(trimmed) || FOOTER_LINE.test(trimmed) || ECHO_LINE.test(trimmed)) continue
      if (BUSY_FOOTER_LINE.test(trimmed) || CSAT_SURVEY_LINE.test(trimmed)) continue
      if (RESUME_COMMAND_LINE.test(trimmed) || THOUGHT_PROCESS_BARE_LINE.test(trimmed)) continue
      if (ELAPSED_TIME_LINE.test(trimmed)) continue

      // CRITICAL (real bug fix): combined into one check, and always resets
      // the flag — a standalone THOUGHT_SUBTITLE_LINE match must reset
      // expectingThoughtLabel too, not just get swallowed by its own regex,
      // or the flag stays stuck true and wrongly swallows whatever real
      // content comes right after it (this exact ordering bug was caught by
      // the existing unit tests when first introduced). Checked before the
      // dedup lookup below so this one-shot "swallow the very next line"
      // state always fires and resets even when that next line's content
      // happens to already be in classifiedLineContents (the subtitle
      // repeats verbatim across turns).
      if (this.expectingThoughtLabel || THOUGHT_SUBTITLE_LINE.test(trimmed)) {
        this.expectingThoughtLabel = false
        continue
      }

      // CRITICAL (real bug fix — see this file's module comment and
      // classifiedLineContents' doc comment): the buffer gets fully
      // re-scanned every snapshot, so a line already turned into an event
      // must be skipped here, not reprocessed.
      if (this.classifiedLineContents.has(trimmed)) continue
      this.classifiedLineContents.add(trimmed)

      const thoughtMatch = trimmed.match(THOUGHT_LINE)
      if (thoughtMatch) {
        flushProse()
        this.expectingThoughtLabel = true
        events.push({ type: 'activity', label: 'Thinking', elapsedMs: Number(thoughtMatch[1]) * 1000 })
        continue
      }

      const toolMatch = trimmed.match(TOOL_ACTIVITY_LINE)
      if (toolMatch) {
        flushProse()
        events.push({ type: 'tool_activity', label: `${toolMatch[1]}(${toolMatch[2]})`, status: 'done' })
        continue
      }

      proseLines.push(trimmed)
    }
    flushProse()
  }
}
