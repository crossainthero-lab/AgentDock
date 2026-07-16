// Antigravity adapter — drives a persistent, genuinely interactive `agy`
// session (the real Antigravity CLI executable name, confirmed via
// `agy --version`/`agy --help`) inside a real PTY for the session's
// lifetime. `-i`/`--prompt-interactive` ("Run an initial prompt
// interactively and continue the session") primes the first turn; later
// turns write into the same live PTY.
//
// Permission mode is one of agy's own real flag values (see
// capability-registry.ts):
//   accept-edits -> --mode accept-edits
//   plan         -> --mode plan
//   bypass       -> --dangerously-skip-permissions
// `default` passes nothing, leaving agy's own default behavior.
//
// Known limitation: no cross-AgentDock-restart continuation is implemented
// (agy does support `--continue`/`-c`, but wiring it up reliably requires
// verifying agy's actual resume semantics, which wasn't done here) — each
// fresh AgentDock session starts a fresh agy conversation.
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
import { AntigravityClassifier } from './AntigravityClassifier'
import { AntigravityInputTranslator } from './AntigravityInputTranslator'

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

class AntigravityRunHandle implements AgentRunHandle {
  private controller: TerminalSessionController | null = null
  private readonly eventListeners = new Set<(event: AgentEvent) => void>()
  private readonly rawDataListeners = new Set<(chunk: string) => void>()
  private readonly exitListeners = new Set<(info: ProcessExitInfo) => void>()
  private readonly classifier = new AntigravityClassifier()
  private conflictState: ConflictState = createConflictState()
  private busyState: BusyHeartbeatState = createBusyHeartbeatState()

  constructor(private readonly ctx: AgentRunContext) {}

  get isRunning(): boolean {
    return this.controller?.isRunning ?? false
  }

  send(prompt: string): void {
    // Reset per turn, not per process — see ClaudeAdapter's send() for why.
    this.busyState = createBusyHeartbeatState()

    if (this.controller && this.controller.isRunning) {
      console.log(`[antigravity] writing to existing pid=${this.controller.pid}`)
      this.controller.write(formatPromptForPty(prompt))
      return
    }

    const args: string[] = [...permissionArgs(this.ctx.permissionMode), '-i', prompt]

    const redactedArgs = [...args.slice(0, -1), '<prompt>']
    console.log(`[antigravity] launching interactive session, args (prompt redacted): ${JSON.stringify(redactedArgs)}`)
    this.controller = createTerminalSessionController(this.ctx.executablePath, args, { cwd: this.ctx.workspacePath })
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
      for (const event of events) this.emit(event)
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
    this.controller?.write(AntigravityInputTranslator.formatInteractionResponse(optionId))
  }

  setModel(): void {
    console.warn('[antigravity] setModel() called but agy has no verified live model-switch command')
  }

  runCommand(): void {
    console.warn('[antigravity] runCommand() called but agy has no known slash commands yet')
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
