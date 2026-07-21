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
// CRITICAL (real bug fix): agy's own transient "Generating..." status text
// (real captured shape, shown immediately below the echoed prompt while a
// turn is in flight) — a real reply can settle into a row this line
// previously occupied, so it must be filtered by content, not just skipped
// via position.
const GENERATING_LINE = /^Generating\.\.\.$/i
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
function normalizeForEchoMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** True if `candidateAfterArrow` (already stripped of a leading "> ") is
 *  consistent with being the (possibly visually-wrapped, possibly still
 *  mid-type) echo of `prompt`. Prefix-matches in the shorter direction so
 *  both a short candidate against a long prompt (early in a multi-line
 *  wrap) and a short prompt fully contained in a padded candidate line
 *  match correctly. */
function looksLikePromptEcho(candidateAfterArrow: string, prompt: string): boolean {
  const candidate = normalizeForEchoMatch(candidateAfterArrow)
  const expected = normalizeForEchoMatch(prompt)
  if (!candidate || !expected) return false
  const shorterLen = Math.min(candidate.length, expected.length)
  if (shorterLen === 0) return false
  return candidate.slice(0, shorterLen) === expected.slice(0, shorterLen)
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
    this.sawBusyThisTurn = false
    this.turnStartedAtMs = Date.now()
    this.requiresEcho = options?.requiresEcho ?? true
  }

  /** Independently re-scans on every snapshot until this turn's own echo is
   *  found — see this file's module comment for why a forward-advancing
   *  watermark can't be used here. Bounded below by lastConsumedEchoIndex
   *  (falling back to 0 if the buffer has since shrunk below it — see its
   *  doc comment) so a prior turn's own — possibly textually identical —
   *  echo is never mistaken for this turn's. */
  private scanForTurnEcho(lines: string[]): void {
    if (this.sawTurnEcho) return
    const lowerBound =
      this.lastConsumedEchoIndex !== null && lines.length > this.lastConsumedEchoIndex ? this.lastConsumedEchoIndex + 1 : 0
    for (let i = lowerBound; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (!ECHO_LINE.test(trimmed)) continue
      if (looksLikePromptEcho(trimmed.replace(ECHO_LINE, ''), this.expectedPrompt)) {
        this.sawTurnEcho = true
        this.turnEchoLineIndex = i
        this.lastConsumedEchoIndex = i
        return
      }
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
      const trimmed = rawLines[offset].trim()

      // Chrome (startup banner on turn 1; potentially leftover/redrawn
      // chrome from the previous turn's idle screen on turn 2+) up to and
      // including this turn's own echoed prompt line stays suppressed —
      // everything at or before turnEchoLineIndex, whether that's from an
      // earlier batch or this very one.
      if (this.turnEchoLineIndex === null || startIndex + offset <= this.turnEchoLineIndex) continue

      if (trimmed === '') continue
      if (SEPARATOR_LINE.test(trimmed) || FOOTER_LINE.test(trimmed) || ECHO_LINE.test(trimmed)) continue
      if (BUSY_FOOTER_LINE.test(trimmed) || CSAT_SURVEY_LINE.test(trimmed) || GENERATING_LINE.test(trimmed)) continue
      if (RESUME_COMMAND_LINE.test(trimmed)) continue

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
