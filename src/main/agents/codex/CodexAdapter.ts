// Codex adapter — structured JSON transport. Each turn spawns a fresh
// `codex exec --json` process (see CodexJsonlTransport), parses its JSONL
// output directly (see CodexEventMapper) into the shared AgentEvent
// vocabulary, and resumes the same native thread on the next turn via
// `codex exec resume <thread_id>` using the real thread_id captured from
// the first turn's `thread.started` event. No PTY, no terminal screen
// classification.
import type { AgentEvent } from '@shared/events/agent-event'
import type { AgentDetection } from '@shared/types'
import { detectionService } from '../../services/detection-service'
import type { ProcessExitInfo } from '../../services/pty-service'
import { CodexJsonlTransport } from './CodexJsonlTransport'
import { CodexEventMapper, createCodexMapperState, type CodexMapperState } from './CodexEventMapper'
import type { AgentAdapter, AgentRunContext, AgentRunHandle } from '../agent-adapter'
import { getCapabilities } from '../capability-registry'

class CodexRunHandle implements AgentRunHandle {
  private transport: CodexJsonlTransport | null = null
  private mapperState: CodexMapperState = createCodexMapperState()
  private capturedThreadId: string | null = null
  private interruptedByUser = false
  private readonly eventListeners = new Set<(event: AgentEvent) => void>()
  private readonly exitListeners = new Set<(info: ProcessExitInfo) => void>()

  constructor(private readonly ctx: AgentRunContext) {}

  get isRunning(): boolean {
    return this.transport?.isRunning ?? false
  }

  send(prompt: string, turnId: string): void {
    this.interruptedByUser = false
    this.mapperState = createCodexMapperState()

    const transport = new CodexJsonlTransport(this.ctx.executablePath, {
      cwd: this.ctx.workspacePath,
      permissionMode: this.ctx.permissionMode,
      nativeThreadId: this.ctx.nativeSessionId,
      modelId: null
    })
    this.transport = transport

    transport.onLine((line) => {
      const { events, state, capturedThreadId } = CodexEventMapper.mapLine(line, this.mapperState, this.ctx.session.id, turnId)
      this.mapperState = state
      if (capturedThreadId) this.capturedThreadId = capturedThreadId
      for (const event of events) this.emit(event)
    })

    transport.onExit((info) => {
      if (!this.mapperState.sawCompletion) {
        const reason = this.interruptedByUser
          ? 'Interrupted by user.'
          : `Codex exited unexpectedly (code ${info.exitCode ?? 'unknown'}) without completing this turn.`
        this.emit({ type: 'turn_failed', sessionId: this.ctx.session.id, turnId, reason })
      }
      for (const listener of this.exitListeners) listener(info)
    })

    transport.start(prompt)
  }

  write(): void {
    console.warn('[codex] write() is a no-op — the structured transport has no PTY to write into')
  }

  resize(): void {
    // No-op — no PTY, nothing to resize.
  }

  interrupt(): void {
    this.interruptedByUser = true
    this.transport?.kill()
  }

  stop(): void {
    this.transport?.kill()
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
    console.warn('[codex] respondToInteraction() is unsupported — the structured transport has not been observed to pause mid-turn')
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
