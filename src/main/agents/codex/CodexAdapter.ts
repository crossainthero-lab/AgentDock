// Codex adapter — drives a persistent, genuinely interactive `codex` TUI
// inside a real PTY for the lifetime of the AgentDock session.
// `codex --help` confirms: "If no subcommand is specified, options will be
// forwarded to the interactive CLI". `--no-alt-screen` keeps the TUI in
// inline/scrollback mode instead of the full-screen alternate buffer.
//
// permissionMode is one of Codex's own real `-a/--ask-for-approval` values
// (untrusted/on-request/never) or 'bypass', mapped straight onto
// `--dangerously-bypass-approvals-and-sandbox` — see capability-registry.ts
// for where these ids are declared and surfaced in the UI.
//
// Known limitation: no verified flag/command exists for "resume the
// previous interactive session and inject the next prompt", so
// cross-AgentDock-restart continuation isn't implemented for Codex.
import type { AgentEvent } from '@shared/events/agent-event'
import type { AgentDetection } from '@shared/types'
import { detectionService } from '../../services/detection-service'
import type { ProcessExitInfo } from '../../services/pty-service'
import { createTerminalSessionController, type TerminalSessionController } from '../../terminal/TerminalSessionController'
import { formatPromptForPty } from '../shared/terminal-text'
import type { AgentAdapter, AgentRunContext, AgentRunHandle } from '../agent-adapter'
import { getCapabilities } from '../capability-registry'
import { createConflictState, withConflictDetection, type ConflictState } from '../shared/conflict-integration'
import { CodexClassifier } from './CodexClassifier'
import { CodexInputTranslator } from './CodexInputTranslator'

class CodexRunHandle implements AgentRunHandle {
  private controller: TerminalSessionController | null = null
  private readonly eventListeners = new Set<(event: AgentEvent) => void>()
  private readonly rawDataListeners = new Set<(chunk: string) => void>()
  private readonly exitListeners = new Set<(info: ProcessExitInfo) => void>()
  private readonly classifier = new CodexClassifier()
  private conflictState: ConflictState = createConflictState()

  constructor(private readonly ctx: AgentRunContext) {}

  get isRunning(): boolean {
    return this.controller?.isRunning ?? false
  }

  send(prompt: string): void {
    if (this.controller && this.controller.isRunning) {
      console.log(`[codex] writing to existing pid=${this.controller.pid}`)
      this.controller.write(formatPromptForPty(prompt))
      return
    }

    const args: string[] = ['--no-alt-screen']
    if (this.ctx.permissionMode === 'bypass') {
      args.push('--dangerously-bypass-approvals-and-sandbox')
    } else if (this.ctx.permissionMode !== 'default') {
      // Real values from `codex --help` -a/--ask-for-approval: untrusted,
      // on-request, never (see capability-registry.ts).
      args.push('--ask-for-approval', this.ctx.permissionMode)
    }
    args.push('-C', this.ctx.workspacePath)
    args.push(prompt)

    const redactedArgs = [...args.slice(0, -1), '<prompt>']
    console.log(`[codex] launching interactive session, args (prompt redacted): ${JSON.stringify(redactedArgs)}`)
    this.controller = createTerminalSessionController(this.ctx.executablePath, args, { cwd: this.ctx.workspacePath })
    this.classifier.reset()
    this.conflictState = createConflictState()

    this.controller.onRawData((chunk) => {
      for (const l of this.rawDataListeners) l(chunk)
    })
    this.controller.onSnapshot((snapshot) => {
      const classified = this.classifier.classify(snapshot)
      const { events, state } = withConflictDetection(this.conflictState, snapshot, classified)
      this.conflictState = state
      for (const event of events) this.emit(event)
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
    this.controller?.write(CodexInputTranslator.formatInteractionResponse(optionId))
  }

  setModel(): void {
    // Not supported live — capabilities.models is empty so the UI never
    // offers this; guard here anyway rather than silently misbehaving.
    console.warn('[codex] setModel() called but Codex has no verified live model-switch command')
  }

  runCommand(commandId: string): void {
    this.controller?.write(CodexInputTranslator.formatCommand(commandId))
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
