// Claude Code adapter — structured JSON transport. Each turn spawns a fresh
// non-interactive `claude -p` process (see ClaudeStreamJsonTransport),
// parses its newline-delimited stream-json output directly (see
// ClaudeEventMapper) into the shared AgentEvent vocabulary, and resumes the
// same native conversation on the next turn via the real `session_id`
// captured from the first turn's `system init` event. No PTY, no terminal
// screen classification.
import type { AgentEvent } from '@shared/events/agent-event'
import type { AgentDetection } from '@shared/types'
import { detectionService } from '../../services/detection-service'
import type { ProcessExitInfo } from '../../services/pty-service'
import { ClaudeStreamJsonTransport } from './ClaudeStreamJsonTransport'
import { ClaudeEventMapper, createClaudeMapperState, type ClaudeMapperState } from './ClaudeEventMapper'
import type { AgentAdapter, AgentRunContext, AgentRunHandle } from '../agent-adapter'
import { getCapabilities } from '../capability-registry'

class ClaudeRunHandle implements AgentRunHandle {
  private transport: ClaudeStreamJsonTransport | null = null
  private mapperState: ClaudeMapperState = createClaudeMapperState()
  private capturedNativeSessionId: string | null = null
  private interruptedByUser = false
  private pendingModelId: string | null = null
  private readonly eventListeners = new Set<(event: AgentEvent) => void>()
  private readonly exitListeners = new Set<(info: ProcessExitInfo) => void>()

  constructor(private readonly ctx: AgentRunContext) {}

  get isRunning(): boolean {
    return this.transport?.isRunning ?? false
  }

  send(prompt: string, turnId: string): void {
    this.interruptedByUser = false
    this.mapperState = createClaudeMapperState()

    const transport = new ClaudeStreamJsonTransport(this.ctx.executablePath, {
      cwd: this.ctx.workspacePath,
      permissionMode: this.ctx.permissionMode,
      nativeSessionId: this.ctx.nativeSessionId,
      modelId: this.pendingModelId
    })
    this.pendingModelId = null
    this.transport = transport

    transport.onLine((line) => {
      const { events, state, capturedSessionId } = ClaudeEventMapper.mapLine(line, this.mapperState, this.ctx.session.id, turnId)
      this.mapperState = state
      if (capturedSessionId) this.capturedNativeSessionId = capturedSessionId
      for (const event of events) this.emit(event)
    })

    transport.onExit((info) => {
      if (!this.mapperState.sawResult) {
        const reason = this.interruptedByUser
          ? 'Interrupted by user.'
          : `Claude exited unexpectedly (code ${info.exitCode ?? 'unknown'}) without completing this turn.`
        this.emit({ type: 'turn_failed', sessionId: this.ctx.session.id, turnId, reason })
      }
      for (const listener of this.exitListeners) listener(info)
    })

    transport.start(prompt)
  }

  write(): void {
    console.warn('[claude] write() is a no-op — the structured transport has no PTY to write into')
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
    // Never fires — Claude sessions have no PTY/raw screen to relay, and
    // the Terminal drawer is hidden for structuredOutput agents.
    return () => {}
  }

  onProcessExit(cb: (info: ProcessExitInfo) => void): () => void {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }

  respondToInteraction(): void {
    console.warn('[claude] respondToInteraction() is unsupported — the structured transport has not been observed to pause mid-turn')
  }

  setModel(modelId: string): void {
    // No live process to redirect (each turn is a fresh invocation) —
    // applies starting the next turn.
    this.pendingModelId = modelId
  }

  runCommand(): void {
    console.warn('[claude] runCommand() is unsupported under the structured transport')
  }

  getNativeSessionId(): string | null {
    return this.capturedNativeSessionId
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.eventListeners) listener(event)
  }
}

export const claudeAdapter: AgentAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',

  detect(customPath: string | null): Promise<AgentDetection> {
    return detectionService.detect('claude-code', customPath)
  },

  start(ctx: AgentRunContext): AgentRunHandle {
    return new ClaudeRunHandle(ctx)
  },

  getCapabilities() {
    return getCapabilities('claude-code')
  }
}
