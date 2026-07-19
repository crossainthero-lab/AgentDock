// Antigravity adapter — drives a persistent, genuinely interactive `agy`
// session (the real Antigravity CLI executable name, confirmed via
// `agy --version`/`agy --help`) inside a real PTY for the session's
// lifetime. `-i`/`--prompt-interactive` ("Run an initial prompt
// interactively and continue the session") primes the first turn; later
// turns write into the same live PTY.
//
// This is the one remaining PTY-classified agent — Claude and Codex moved
// to structured JSON transports (see ClaudeAdapter/CodexAdapter) and no
// longer touch any of TerminalSessionController/TerminalScreenBuffer/
// conflict-integration/classifiers. Confirmed live (real `agy 1.1.4`
// sessions via node-pty, real `agy --help`/`agy changelog`/`agy models`):
// there is no JSON, gRPC-reflectable, or other documented structured
// protocol exposed by the installed CLI — `agy` runs a private internal
// gRPC "language server" on a random local port purely for its own use
// (visible only in its log file), which is not a stable, documented
// integration surface, so PTY translation remains the correct choice per
// the task's own preference order. AntigravityClassifier still classifies
// the raw screen into the old flat vocabulary (ClassifiedScreenEvent, see
// classified-event.ts); AntigravityEventMapper is the one place that
// translates that into the shared, turn-scoped AgentEvent model everything
// else (including Claude/Codex) speaks.
//
// Permission mode is one of agy's own real flag values (see
// capability-registry.ts):
//   accept-edits -> --mode accept-edits
//   plan         -> --mode plan
//   bypass       -> --dangerously-skip-permissions
// `default` passes nothing, leaving agy's own default behavior.
//
// Fixed here (previously real, confirmed bugs — see the task's investigation
// notes for the live evidence behind each):
//   - `--add-dir <workspacePath>` was never passed. Confirmed live: without
//     it, agy ignores the process cwd entirely and operates against its own
//     default project directory (`~/.gemini/antigravity-cli/scratch`), so
//     every session was silently running against the wrong directory.
//   - `ctx.model`/`--model` was never applied at all.
//   - There was no live per-turn completion signal — `turn_completed` was
//     only ever emitted from the PTY process actually exiting, but agy's
//     interactive session stays alive across turns by design, so a second
//     (or any later) turn could never resolve and would sit on "Working…"
//     until the 3-minute stale-turn fallback. Fixed by detecting the real,
//     confirmed footer-text transition ("esc to cancel" -> "? for
//     shortcuts") as a live per-turn `turn_ready` signal, independent of
//     process exit (see AntigravityClassifier.ts).
//   - `interrupt()` sent Ctrl+C, which real testing showed is NOT the
//     correct in-turn cancel key for agy (Ctrl+C is reserved for exiting
//     the whole session and needs a second press). The real, verified
//     cancel key is Escape ("esc to cancel" is agy's own on-screen hint) —
//     confirmed live to cancel only the in-flight turn while the process
//     and conversation stay alive for a follow-up.
//   - Neither stop() nor interrupt() distinguished a deliberate user action
//     from a genuine crash, so both produced a fabricated
//     "Antigravity exited with code N" turn_failed instead of a clean
//     turn_cancelled.
//   - getNativeSessionId() always returned null. agy genuinely supports
//     resuming a conversation via `--conversation <id>` (confirmed live:
//     a fresh process resumed with the real id correctly recalled context
//     from an earlier, separate process) — the id itself isn't printed
//     anywhere in the normal chat flow, but is shown on the /help screen's
//     "general" tab ("Conversation: <uuid>"), so it's captured once, after
//     the first turn completes, via a scripted /help-open/scrape/close
//     round trip the user never sees.
//   - Image attachments didn't exist at all. agy has no `--image`-style CLI
//     flag (confirmed: none exists in `agy --help`) — its genuine native
//     mechanism is real OS-clipboard paste, confirmed both in the CLI's own
//     changelog ("Allowed image pasting from the clipboard", "Fixed
//     Windows ... clipboard image and file reading") and live: writing a
//     real PNG onto the Windows clipboard and sending a literal Ctrl+V
//     (0x16) into a real `agy -i` PTY session produced the screen line
//     "▸ 📎 1 media attached (clipboard, 141 B, image/png)". send() now
//     performs that exact choreography for each attachment before writing
//     the text prompt, saving and restoring the user's real clipboard
//     content around it (see pasteImagesThenSend).
import { clipboard, nativeImage } from 'electron'
import type { AgentEvent } from '@shared/events/agent-event'
import type { AgentDetection } from '@shared/types'
import { detectionService } from '../../services/detection-service'
import type { ProcessExitInfo } from '../../services/pty-service'
import { createTerminalSessionController, type TerminalSessionController } from '../../terminal/TerminalSessionController'
import type { ScreenSnapshot } from '../../terminal/TerminalScreenBuffer'
import { formatPromptForPty } from '../shared/terminal-text'
import type { AgentAdapter, AgentRunContext, AgentRunHandle } from '../agent-adapter'
import { getCapabilities } from '../capability-registry'
import {
  busyHeartbeatEvent,
  createBusyHeartbeatState,
  createConflictState,
  noteClassifiedActivity,
  withConflictDetection,
  type BusyHeartbeatState,
  type ConflictState
} from '../shared/conflict-integration'
import { AntigravityClassifier } from './AntigravityClassifier'
import { AntigravityInputTranslator } from './AntigravityInputTranslator'
import { AntigravityEventMapper, createAntigravityMapperState, type AntigravityMapperState } from './AntigravityEventMapper'

function permissionArgs(mode: AgentRunContext['permissionMode']): string[] {
  switch (mode) {
    case 'accept-edits':
      return ['--mode', 'accept-edits']
    case 'plan':
      return ['--mode', 'plan']
    case 'bypass':
      return ['--dangerously-skip-permissions']
    default:
      return []
  }
}

// Real captured shape, confirmed live on the /help screen's "general" tab:
// "Conversation:   de953c71-d7e7-436a-b438-8d46504f2735".
const CONVERSATION_ID_PATTERN = /Conversation:\s*([0-9a-fA-F-]{20,})/
const CONVERSATION_ID_CAPTURE_TIMEOUT_MS = 6000

// Real captured confirmation marker for a successful clipboard paste:
// "▸ 📎 1 media attached (clipboard, 141 B, image/png)  (ctrl+o to expand)".
const MEDIA_ATTACHED_PATTERN = /📎\s*(\d+)\s*media attached/
const PASTE_CONFIRM_TIMEOUT_MS = 6000
const PASTE_POLL_INTERVAL_MS = 200
const CTRL_V = '\x16'

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === 'turn_completed' || event.type === 'turn_failed'
}

class AntigravityRunHandle implements AgentRunHandle {
  private controller: TerminalSessionController | null = null
  private readonly eventListeners = new Set<(event: AgentEvent) => void>()
  private readonly rawDataListeners = new Set<(chunk: string) => void>()
  private readonly exitListeners = new Set<(info: ProcessExitInfo) => void>()
  private readonly classifier = new AntigravityClassifier()
  private conflictState: ConflictState = createConflictState()
  private busyState: BusyHeartbeatState = createBusyHeartbeatState()
  private mapperState: AntigravityMapperState = createAntigravityMapperState()
  private currentTurnId = ''
  private currentModel: string | null
  /** The real agy conversation id — seeded immediately from
   *  ctx.nativeSessionId when resuming a session that already has one
   *  persisted from a prior turn/AgentDock restart, otherwise captured once
   *  via a one-time /help scrape after the first turn completes (see
   *  beginConversationIdCapture). */
  private nativeConversationId: string | null
  private capturingConversationId = false
  private pendingCompletionEvents: AgentEvent[] = []
  private conversationIdCaptureTimer: ReturnType<typeof setTimeout> | null = null
  /** Set by interrupt() — agy has no distinct "cancelled" screen state of
   *  its own (ESC just returns it to the same idle-ready screen a normal
   *  completion does), so the next turn_completed the classifier would
   *  otherwise produce is reinterpreted as turn_cancelled instead. */
  private turnWasInterrupted = false
  /** Set by stop()/setModel() — distinguishes a deliberate kill from a
   *  genuine crash when the process then exits. */
  private userCausedExit = false
  /** True from a fresh bare-spawned process (no `-i <prompt>` — attachments
   *  need the process fully idle/trusted before pasting) until the first
   *  genuine idle transition, at which point pasteImagesThenSend() takes
   *  over. While true, ordinary classification (including a genuine
   *  workspace-trust prompt) still runs and is still emitted — only the
   *  turn_completed that idle transition would otherwise produce is
   *  suppressed, since no real turn has been sent to answer yet. */
  private attachingImages = false
  private pendingAttachImages: string[] = []
  private pendingAttachPrompt = ''
  /** Highest "N media attached" count seen on screen so far this process
   *  lifetime — used to confirm each Ctrl+V paste actually landed before
   *  moving on to the next attachment or the real text prompt. */
  private mediaAttachedCount = 0

  constructor(private readonly ctx: AgentRunContext) {
    this.currentModel = ctx.model
    this.nativeConversationId = ctx.nativeSessionId
  }

  get isRunning(): boolean {
    return this.controller?.isRunning ?? false
  }

  send(prompt: string, turnId: string, images?: string[]): void {
    // Reset per turn, not per process — the live PTY (and its controller's
    // listeners) persists across turns, but "has a specific activity been
    // classified yet" and "which message is this turn's deltas going into"
    // are inherently scoped to the turn currently in flight.
    this.busyState = createBusyHeartbeatState()
    this.mapperState = createAntigravityMapperState()
    this.currentTurnId = turnId
    this.turnWasInterrupted = false
    this.userCausedExit = false
    // CRITICAL (real bug fix, found via a dedicated regression test): NOT
    // calling classifier.beginTurn(prompt) here anymore — the fresh-spawn
    // branch below used to call classifier.reset() (process-lifetime state)
    // *after* this same beginTurn() call, silently wiping the turn-scoped
    // expectedPrompt it had just set. Since looksLikePromptEcho refuses to
    // match against an empty expected prompt, sawTurnEcho could then never
    // become true for that entire first turn on a freshly spawned process —
    // completion (turn_ready) still fired correctly (it doesn't depend on
    // sawTurnEcho), but zero real content was ever classified, so the first
    // message of every brand-new session would settle as a completed turn
    // with no reply at all. beginTurn() is now called once, at the very end
    // of each branch below, strictly after any reset() — see there.

    // Reported up front rather than waiting for an echo — agy's screen text
    // never echoes the active model back the way Claude's system/init does,
    // so this is exactly what the process is about to be spawned with (or,
    // for a reused process, already running with), not a guess.
    if (this.currentModel) {
      this.emit({ type: 'model_info', sessionId: this.ctx.session.id, turnId, model: this.currentModel })
    }

    const hasImages = !!images && images.length > 0

    if (this.controller && this.controller.isRunning) {
      console.log(`[antigravity] writing to existing pid=${this.controller.pid}`)
      this.classifier.beginTurn(prompt)
      if (hasImages) {
        void this.pasteImagesThenSend(images as string[], prompt)
      } else {
        this.controller.write(formatPromptForPty(prompt))
      }
      return
    }

    const args: string[] = [...permissionArgs(this.ctx.permissionMode), '--add-dir', this.ctx.workspacePath]
    if (this.currentModel) args.push('--model', this.currentModel)
    if (this.nativeConversationId) args.push('--conversation', this.nativeConversationId)
    // With attachments, the process is spawned bare (no `-i`) — the real
    // prompt is written normally, after the images are pasted, once the
    // fresh process is confirmed idle/ready (see attachingImages above).
    if (!hasImages) args.push('-i', prompt)

    const redactedArgs = hasImages ? args : [...args.slice(0, -1), '<prompt>']
    console.log(`[antigravity] launching interactive session, args (prompt redacted): ${JSON.stringify(redactedArgs)}`)
    this.controller = createTerminalSessionController(this.ctx.executablePath, args, { cwd: this.ctx.workspacePath })
    this.classifier.reset()
    // Bare-spawn attachment bootstrap (hasImages): nothing is written to the
    // PTY until pasteImagesThenSend's own beginTurn() call right before the
    // real prompt write — no echo is possible yet, so it must not be
    // required here (see AntigravityClassifier's requiresEcho doc comment).
    this.classifier.beginTurn(prompt, { requiresEcho: !hasImages })
    this.conflictState = createConflictState()
    this.mediaAttachedCount = 0
    if (hasImages) {
      this.attachingImages = true
      this.pendingAttachImages = images as string[]
      this.pendingAttachPrompt = prompt
    }

    this.controller.onRawData((chunk) => {
      for (const l of this.rawDataListeners) l(chunk)
    })
    this.controller.onSnapshot((snapshot) => this.handleSnapshot(snapshot))
    this.controller.onBusy(() => {
      const heartbeat = busyHeartbeatEvent(this.busyState)
      if (!heartbeat) return
      const { events, state: mapperState } = AntigravityEventMapper.map([heartbeat], this.mapperState, this.ctx.session.id, this.currentTurnId)
      this.mapperState = mapperState
      for (const event of events) this.emit(event)
    })
    this.controller.onExit((info) => {
      if (this.userCausedExit) {
        this.emit({ type: 'turn_cancelled', sessionId: this.ctx.session.id, turnId: this.currentTurnId })
        for (const l of this.exitListeners) l(info)
        return
      }
      const classified: Parameters<typeof AntigravityEventMapper.map>[0] = [{ type: 'session_complete', exitCode: info.exitCode }]
      const { events } = AntigravityEventMapper.map(classified, this.mapperState, this.ctx.session.id, this.currentTurnId)
      for (const event of events) this.emit(event)
      for (const l of this.exitListeners) l(info)
    })
  }

  private handleSnapshot(snapshot: ScreenSnapshot): void {
    // While waiting on the one-time /help scrape, the classifier must not
    // see this screen at all — it's an overlay unrelated to the
    // conversation, and would otherwise be misclassified as prose/activity.
    if (this.capturingConversationId) {
      this.consumeConversationIdCaptureSnapshot(snapshot)
      return
    }

    this.updateMediaAttachedCount(snapshot)

    const classified = this.classifier.classify(snapshot)
    noteClassifiedActivity(this.busyState, classified)
    const { events: withAttention, state: conflictState } = withConflictDetection(this.conflictState, snapshot, classified)
    this.conflictState = conflictState
    const { events, state: mapperState } = AntigravityEventMapper.map(withAttention, this.mapperState, this.ctx.session.id, this.currentTurnId)
    this.mapperState = mapperState

    if (process.env['AGENTDOCK_DEBUG_RAW_PTY'] && (withAttention.length > 0 || events.length > 0)) {
      console.log(
        `[antigravity:snapshotdebug] turnId=${this.currentTurnId} classified=${JSON.stringify(withAttention)} mappedEventTypes=${JSON.stringify(events.map((e) => e.type))}`
      )
    }

    const reinterpreted = events.map((event) => {
      if (event.type === 'turn_completed' && this.turnWasInterrupted) {
        this.turnWasInterrupted = false
        return { sessionId: event.sessionId, turnId: event.turnId, type: 'turn_cancelled' as const }
      }
      return event
    })

    if (this.attachingImages) {
      // A fresh bare-spawned process reaching idle for the first time means
      // it's fully trusted/ready — genuine content up to now (e.g. the
      // workspace-trust interaction itself) still flows through normally;
      // only the resulting turn_completed is suppressed, since no real
      // turn has been sent yet for it to correctly resolve.
      for (const event of reinterpreted) {
        if (event.type !== 'turn_completed') this.emit(event)
      }
      if (reinterpreted.some(isTerminalEvent)) {
        this.attachingImages = false
        void this.pasteImagesThenSend(this.pendingAttachImages, this.pendingAttachPrompt)
      }
      return
    }

    // Only ever attempted once per handle — the very first time this
    // handle's turn reaches a terminal state with no conversation id known
    // yet (either never captured, or this session was never resumed).
    if (!this.nativeConversationId && !this.capturingConversationId && reinterpreted.some(isTerminalEvent)) {
      const nonTerminal = reinterpreted.filter((e) => !isTerminalEvent(e))
      for (const event of nonTerminal) this.emit(event)
      this.beginConversationIdCapture(reinterpreted.filter(isTerminalEvent))
      return
    }

    for (const event of reinterpreted) this.emit(event)
  }

  private updateMediaAttachedCount(snapshot: ScreenSnapshot): void {
    for (const line of snapshot.lines) {
      const match = line.match(MEDIA_ATTACHED_PATTERN)
      if (match) {
        const count = Number(match[1])
        if (count > this.mediaAttachedCount) this.mediaAttachedCount = count
      }
    }
  }

  /** Real, verified clipboard-paste choreography (see this file's module
   *  comment for the live evidence): writes each image onto the OS
   *  clipboard, sends Ctrl+V, and waits for agy's own on-screen
   *  confirmation ("N media attached") before moving to the next one —
   *  never a fixed blind delay. The user's real clipboard content is saved
   *  before the first paste and restored afterward, whether or not every
   *  attachment succeeded. */
  private async pasteImagesThenSend(images: string[], prompt: string): Promise<void> {
    let savedImage: Electron.NativeImage | null = null
    let savedText: string | null = null
    try {
      const img = clipboard.readImage()
      if (!img.isEmpty()) savedImage = img
      else savedText = clipboard.readText()
    } catch (err) {
      console.warn('[antigravity] could not read the current clipboard to restore it later:', err)
    }

    for (const imagePath of images) {
      try {
        const img = nativeImage.createFromPath(imagePath)
        if (img.isEmpty()) {
          console.warn(`[antigravity] could not load "${imagePath}" as an image — skipped`)
          continue
        }
        const expected = this.mediaAttachedCount + 1
        clipboard.writeImage(img)
        this.controller?.write(CTRL_V)
        await this.waitForMediaAttachedAtLeast(expected, PASTE_CONFIRM_TIMEOUT_MS)
        if (this.mediaAttachedCount < expected) {
          console.warn(`[antigravity] paste confirmation for "${imagePath}" never appeared within ${PASTE_CONFIRM_TIMEOUT_MS}ms`)
        }
      } catch (err) {
        console.warn(`[antigravity] failed to paste attachment "${imagePath}":`, err)
      }
    }

    try {
      if (savedImage) clipboard.writeImage(savedImage)
      else if (savedText) clipboard.writeText(savedText)
      else clipboard.clear()
    } catch (err) {
      console.warn('[antigravity] could not restore the original clipboard content:', err)
    }

    // The suppressed idle transition above already consumed this turn's
    // classifier-level "ready" flag — reset it (and re-arm the echo match
    // against the real prompt now actually being sent) so the real
    // completion, once this actual prompt resolves, is detected normally.
    this.classifier.beginTurn(prompt)
    this.controller?.write(formatPromptForPty(prompt))
  }

  private async waitForMediaAttachedAtLeast(count: number, timeoutMs: number): Promise<void> {
    const start = Date.now()
    while (this.mediaAttachedCount < count && Date.now() - start < timeoutMs) {
      await wait(PASTE_POLL_INTERVAL_MS)
    }
  }

  private beginConversationIdCapture(pendingEvents: AgentEvent[]): void {
    this.capturingConversationId = true
    this.pendingCompletionEvents = pendingEvents
    this.controller?.write('/help\r')
    this.conversationIdCaptureTimer = setTimeout(() => this.finishConversationIdCapture(null), CONVERSATION_ID_CAPTURE_TIMEOUT_MS)
  }

  private consumeConversationIdCaptureSnapshot(snapshot: ScreenSnapshot): void {
    const match = snapshot.lines.join('\n').match(CONVERSATION_ID_PATTERN)
    if (match) this.finishConversationIdCapture(match[1])
    // No match yet: keep waiting for a later snapshot, or the timeout.
  }

  private finishConversationIdCapture(id: string | null): void {
    if (!this.capturingConversationId) return
    this.capturingConversationId = false
    if (this.conversationIdCaptureTimer) {
      clearTimeout(this.conversationIdCaptureTimer)
      this.conversationIdCaptureTimer = null
    }
    if (id) this.nativeConversationId = id
    else console.warn('[antigravity] could not capture a conversation id from /help — this session will not be resumable after an AgentDock restart')
    this.controller?.write('\x1b') // closes the /help overlay, returns to the chat view
    const pending = this.pendingCompletionEvents
    this.pendingCompletionEvents = []
    for (const event of pending) this.emit(event)
  }

  write(data: string): void {
    this.controller?.write(data)
  }

  resize(cols: number, rows: number): void {
    this.controller?.resize(cols, rows)
  }

  /** ESC — the real, verified cancel-current-turn mechanism (agy's own
   *  on-screen hint is "esc to cancel" while a turn is in flight). NOT
   *  Ctrl+C: confirmed live that Ctrl+C is reserved for exiting the whole
   *  interactive session (and needs a second press to confirm), not
   *  cancelling one turn — sending it here would kill the entire
   *  conversation instead of just stopping the current reply. */
  interrupt(): void {
    this.turnWasInterrupted = true
    this.controller?.write('\x1b')
  }

  stop(): void {
    this.userCausedExit = true
    this.controller?.kill()
  }

  onEvent(cb: (event: AgentEvent) => void): () => void {
    this.eventListeners.add(cb)
    return () => this.eventListeners.delete(cb)
  }

  onRawData(cb: (chunk: string) => void): () => void {
    this.rawDataListeners.add(cb)
    return () => this.rawDataListeners.delete(cb)
  }

  onProcessExit(cb: (info: ProcessExitInfo) => void): () => void {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }

  respondToInteraction(_interactionId: string, optionId: string): void {
    this.controller?.write(AntigravityInputTranslator.formatInteractionResponse(optionId))
  }

  /** Kills the live process (if any) so the next send() respawns fresh with
   *  the new model — agy has no live in-process model-switch command, so a
   *  fresh process is the only real way to apply one. If a conversation id
   *  has already been captured, the respawn resumes the SAME conversation
   *  under the new model via --conversation (mirrors
   *  CodexAgentSdkTransport.setModel()'s "discard the cached Thread
   *  wrapper, resume by id next turn" pattern); if not, the next send()
   *  just starts a fresh conversation under the new model. */
  setModel(modelId: string): void {
    this.currentModel = modelId
    if (this.controller?.isRunning) {
      this.userCausedExit = true
      this.controller.kill()
    }
  }

  runCommand(): void {
    console.warn('[antigravity] runCommand() called but agy has no known slash commands yet')
  }

  getNativeSessionId(): string | null {
    return this.nativeConversationId
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.eventListeners) listener(event)
  }
}

export const antigravityAdapter: AgentAdapter = {
  id: 'antigravity',
  displayName: 'Antigravity',

  detect(customPath: string | null): Promise<AgentDetection> {
    return detectionService.detect('antigravity', customPath)
  },

  start(ctx: AgentRunContext): AgentRunHandle {
    return new AntigravityRunHandle(ctx)
  },

  getCapabilities() {
    return getCapabilities('antigravity')
  }
}
