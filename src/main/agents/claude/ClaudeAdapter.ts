// Claude Code adapter — drives a persistent, genuinely interactive `claude`
// session inside a real PTY for the lifetime of the AgentDock session.
// `--ax-screen-reader` (a real, documented flag) asks for flat,
// borderless, animation-free output — verified against a real session to be
// dramatically easier to classify than the full decorated TUI (plain
// "you:"/"claude:"/"tool:" prefixed lines and "Permission Required:" blocks
// instead of box-drawing art). The first turn's prompt is passed as the
// trailing positional argv `[prompt]`; later turns write into the same PTY.
import type { AgentEvent } from '@shared/events/agent-event'
import type { AgentDetection } from '@shared/types'
import { detectionService } from '../../services/detection-service'
import type { ProcessExitInfo } from '../../services/pty-service'
import { createTerminalSessionController, type TerminalSessionController } from '../../terminal/TerminalSessionController'
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
import { ClaudeClassifier } from './ClaudeClassifier'
import { ClaudeInputTranslator } from './ClaudeInputTranslator'

/** Sentinel stored in the `nativeSessionId` DB column meaning "this session
 *  has successfully started a Claude process before" — used to decide
 *  whether to pass `--continue` if AgentDock restarts and reconnects. */
const HAS_PRIOR_SESSION_MARKER = 'claude-session-started'

interface PendingAutoSelect {
  kind: 'model'
  modelId: string
}

class ClaudeRunHandle implements AgentRunHandle {
  private controller: TerminalSessionController | null = null
  private readonly eventListeners = new Set<(event: AgentEvent) => void>()
  private readonly rawDataListeners = new Set<(chunk: string) => void>()
  private readonly exitListeners = new Set<(info: ProcessExitInfo) => void>()
  private readonly classifier = new ClaudeClassifier()
  private conflictState: ConflictState = createConflictState()
  private busyState: BusyHeartbeatState = createBusyHeartbeatState()
  private pendingAutoSelect: PendingAutoSelect | null = null
  hasStarted = false

  constructor(private readonly ctx: AgentRunContext) {}

  get isRunning(): boolean {
    return this.controller?.isRunning ?? false
  }

  send(prompt: string): void {
    // Reset per turn, not per process — the live PTY (and its controller's
    // listeners) persists across turns, but "has a specific activity been
    // classified yet" is inherently scoped to the turn currently in flight.
    this.busyState = createBusyHeartbeatState()

    if (this.controller && this.controller.isRunning) {
      console.log(`[claude-code] writing to existing pid=${this.controller.pid}`)
      this.controller.write(formatPromptForPty(prompt))
      return
    }

    const args: string[] = ['--ax-screen-reader']
    if (this.ctx.permissionMode !== 'default') {
      args.push('--permission-mode', this.ctx.permissionMode)
    }
    if (this.ctx.nativeSessionId === HAS_PRIOR_SESSION_MARKER) {
      args.push('--continue')
    }
    args.push(prompt)

    const redactedArgs = [...args.slice(0, -1), '<prompt>']
    console.log(`[claude-code] launching interactive session, args (prompt redacted): ${JSON.stringify(redactedArgs)}`)
    this.controller = createTerminalSessionController(this.ctx.executablePath, args, { cwd: this.ctx.workspacePath })
    this.hasStarted = true
    this.classifier.reset()
    this.conflictState = createConflictState()

    this.controller.onRawData((chunk) => {
      for (const l of this.rawDataListeners) l(chunk)
    })
    this.controller.onSnapshot((snapshot) => {
      const classified = this.classifier.classify(snapshot)
      noteClassifiedActivity(this.busyState, classified)
      const { events, state } = withConflictDetection(this.conflictState, snapshot, classified)
      this.conflictState = state
      this.dispatch(events)
    })
    this.controller.onBusy(() => {
      const heartbeat = busyHeartbeatEvent(this.busyState)
      if (heartbeat) this.emit(heartbeat)
    })
    this.controller.onExit((info) => {
      this.emit({ type: 'session_complete', exitCode: info.exitCode })
      for (const l of this.exitListeners) l(info)
    })
  }

  private dispatch(events: AgentEvent[]): void {
    for (const event of events) {
      if (this.pendingAutoSelect && (event.type === 'choice_required' || event.type === 'permission_required')) {
        // The user already told us what they want via setModel() — answer
        // the resulting menu ourselves instead of surfacing a second card.
        const auto = this.pendingAutoSelect
        this.pendingAutoSelect = null
        if (auto.kind === 'model') {
          this.controller?.write(ClaudeInputTranslator.formatModelSelection(auto.modelId))
        }
        continue
      }
      this.emit(event)
    }
  }

  write(data: string): void {
    this.controller?.write(data)
  }

  resize(cols: number, rows: number): void {
    this.controller?.resize(cols, rows)
  }

  interrupt(): void {
    this.controller?.interrupt()
  }

  stop(): void {
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
    this.controller?.write(ClaudeInputTranslator.formatInteractionResponse(optionId))
  }

  setModel(modelId: string): void {
    this.pendingAutoSelect = { kind: 'model', modelId }
    this.controller?.write(ClaudeInputTranslator.formatOpenModelMenu())
  }

  runCommand(commandId: string): void {
    this.controller?.write(ClaudeInputTranslator.formatCommand(commandId))
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

// Re-exported so session-service can pull the "has a prior conversation"
// marker back out after a turn completes.
export function getClaudeNativeSessionId(handle: AgentRunHandle): string | null {
  return handle instanceof ClaudeRunHandle && handle.hasStarted ? HAS_PRIOR_SESSION_MARKER : null
}
