// Codex adapter — backed by the official Codex SDK (`@openai/codex-sdk`,
// see CodexAgentSdkTransport) instead of a hand-rolled `codex exec --json`
// spawn. The old hand-rolled transport had a fatal bug (Node's default
// stdio left Codex's stdin open, and Codex hangs forever waiting to read
// it before proceeding, even with a prompt already given positionally) —
// see CodexAgentSdkTransport.ts's module comment for the full root-cause
// writeup. The SDK's `Thread` object is kept alive for the session's whole
// lifetime and internally resumes each subsequent turn via its own
// captured thread_id — no hand-maintained resume bookkeeping needed.
//
// Codex's `exec`/SDK surface has no live interactive approval channel
// (confirmed: no `--ask-for-approval` under `codex exec --help`, and
// `@openai/codex-sdk`'s public types expose no approval callback) —
// `respondToInteraction` remains a documented no-op, same honest treatment
// as the analogous gap found for Claude's raw CLI before its own SDK
// migration.
import type { AgentEvent } from '@shared/events/agent-event'
import type { AgentDetection } from '@shared/types'
import type { ThreadEvent } from '@openai/codex-sdk'
import { detectionService } from '../../services/detection-service'
import type { ProcessExitInfo } from '../../services/pty-service'
import { CodexAgentSdkTransport } from './CodexAgentSdkTransport'
import { CodexEventMapper, createCodexMapperState, type CodexMapperState } from './CodexEventMapper'
import type { AgentAdapter, AgentRunContext, AgentRunHandle } from '../agent-adapter'
import { getCapabilities } from '../capability-registry'

class CodexRunHandle implements AgentRunHandle {
  private transport: CodexAgentSdkTransport | null = null
  private mapperState: CodexMapperState = createCodexMapperState()
  private capturedThreadId: string | null = null
  /** Set by stop()/interrupt() before the transport is told to abort — the
   *  signal that distinguishes "the user asked for this" (turn_cancelled)
   *  from a genuine crash (turn_exited). */
  private userCausedExit = false
  private currentTurnId = ''
  private readonly eventListeners = new Set<(event: AgentEvent) => void>()
  private readonly exitListeners = new Set<(info: ProcessExitInfo) => void>()

  constructor(private readonly ctx: AgentRunContext) {}

  get isRunning(): boolean {
    return this.transport?.isRunning ?? false
  }

  send(prompt: string, turnId: string): void {
    this.userCausedExit = false
    this.currentTurnId = turnId
    this.mapperState = createCodexMapperState()

    if (!this.transport) {
      const transport = new CodexAgentSdkTransport({
        cwd: this.ctx.workspacePath,
        executablePath: this.ctx.executablePath,
        permissionMode: this.ctx.permissionMode,
        nativeThreadId: this.ctx.nativeSessionId
      })
      this.transport = transport

      transport.onMessage((msg) => this.handleMessage(msg))
    }

    // start() resolves this specific turn's own result (never a shared
    // broadcast — see CodexAgentSdkTransport.start's doc comment for why
    // that distinction matters). currentTurnId/mapperState are still
    // compared at resolution time, not assumed: if this turn's own
    // resolution arrives after a later send() has already moved on (e.g.
    // this turn actually succeeded and the caller sent a follow-up before
    // this promise settled), that's this turn's own late-but-legitimate
    // "done" signal — by the time it arrives sawCompletion is already
    // true for the turn that finished, but currentTurnId no longer
    // matches, so it's correctly skipped rather than misattributed to
    // whatever turn is active now.
    const turnIdForThisLaunch = turnId
    void this.transport.start(prompt).then((info) => {
      if (this.currentTurnId === turnIdForThisLaunch && !this.mapperState.sawCompletion) {
        if (this.userCausedExit) {
          this.emit({ type: 'turn_cancelled', sessionId: this.ctx.session.id, turnId: this.currentTurnId })
        } else {
          const reason = info.errored && info.reason
            ? `Codex exited unexpectedly: ${info.reason}`
            : 'Codex exited unexpectedly (connection lost) without completing this turn.'
          this.emit({ type: 'turn_exited', sessionId: this.ctx.session.id, turnId: this.currentTurnId, reason })
        }
      }
      for (const listener of this.exitListeners) listener({ exitCode: info.errored ? 1 : 0, signal: null })
    })
  }

  private handleMessage(msg: ThreadEvent): void {
    const { events, state, capturedThreadId } = CodexEventMapper.mapEvent(msg, this.mapperState, this.ctx.session.id, this.currentTurnId)
    this.mapperState = state
    if (capturedThreadId) this.capturedThreadId = capturedThreadId
    for (const event of events) this.emit(event)
  }

  write(): void {
    console.warn('[codex] write() is a no-op — the SDK transport has no PTY to write into')
  }

  resize(): void {
    // No-op — no PTY, nothing to resize.
  }

  interrupt(): void {
    this.userCausedExit = true
    this.transport?.interrupt()
  }

  stop(): void {
    this.userCausedExit = true
    this.transport?.stop()
  }

  onEvent(cb: (event: AgentEvent) => void): () => void {
    this.eventListeners.add(cb)
    return () => this.eventListeners.delete(cb)
  }

  onRawData(): () => void {
    // Never fires — Codex sessions have no PTY/raw screen to relay, and
    // the Terminal drawer is hidden for structuredOutput agents.
    return () => {}
  }

  onProcessExit(cb: (info: ProcessExitInfo) => void): () => void {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }

  respondToInteraction(): void {
    console.warn(
      '[codex] respondToInteraction() is unsupported — codex exec has no live approval channel (no --ask-for-approval under `codex exec --help`; @openai/codex-sdk exposes no approval callback)'
    )
  }

  setModel(): void {
    // Not supported — capabilities.models is empty so the UI never offers
    // this; guard here anyway rather than silently misbehaving.
    console.warn('[codex] setModel() called but Codex has no verified model list for `codex exec`')
  }

  runCommand(): void {
    console.warn('[codex] runCommand() is unsupported under the structured transport')
  }

  getNativeSessionId(): string | null {
    return this.capturedThreadId
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.eventListeners) listener(event)
  }
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  displayName: 'Codex',

  detect(customPath: string | null): Promise<AgentDetection> {
    return detectionService.detect('codex', customPath)
  },

  start(ctx: AgentRunContext): AgentRunHandle {
    return new CodexRunHandle(ctx)
  },

  getCapabilities() {
    return getCapabilities('codex')
  }
}
