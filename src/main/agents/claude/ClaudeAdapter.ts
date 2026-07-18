// Claude Code adapter — backed by the official Claude Agent SDK
// (`@anthropic-ai/claude-agent-sdk`, see ClaudeAgentSdkTransport) instead of
// a hand-rolled raw-CLI spawn. One persistent SDK `query()` backs a whole
// AgentDock session (not one process per turn): interrupt()/setModel()/
// setPermissionMode() are only meaningful in the SDK's streaming-input mode,
// which requires a single long-lived query fed via a pushed async iterable.
//
// Permission handling is real, not simulated: the SDK's `canUseTool`
// callback is invoked by the actual Claude CLI subprocess (over its own
// `--permission-prompt-tool stdio` control protocol, confirmed by reading
// the SDK's bundled source) before a tool actually executes. This adapter
// turns that callback into a normal `interaction_required` AgentEvent,
// blocks until `respondToInteraction` is called, and returns the real
// allow/deny decision back to the SDK — which is what actually determines
// whether Claude runs the command / edits the file. Empirically verified
// live against the installed CLI: a denied `rm` did not delete the file, a
// denied out-of-workspace write did not create the file, and both showed up
// in the turn's `permission_denials`.
//
// `AskUserQuestion` is a normal tool call under the same `canUseTool` gate
// — its answer is delivered back via `updatedInput.answers` (confirmed
// against the SDK's own AskUserQuestionInput type, which documents
// `answers` as "User answers collected by the permission component").
import type { AgentChoice, AgentEvent } from '@shared/events/agent-event'
import type { AgentDetection } from '@shared/types'
import type { CanUseTool, PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { detectionService } from '../../services/detection-service'
import type { ProcessExitInfo } from '../../services/pty-service'
import { ClaudeAgentSdkTransport } from './ClaudeAgentSdkTransport'
import { ClaudeEventMapper, createClaudeMapperState, type ClaudeMapperState } from './ClaudeEventMapper'
import type { AgentAdapter, AgentRunContext, AgentRunHandle } from '../agent-adapter'
import { getCapabilities } from '../capability-registry'

const ASK_USER_QUESTION_TOOL = 'AskUserQuestion'

interface AskUserQuestionOption {
  label: string
  description?: string
}

interface AskUserQuestionEntry {
  question: string
  header: string
  options: AskUserQuestionOption[]
}

class ClaudeRunHandle implements AgentRunHandle {
  private transport: ClaudeAgentSdkTransport | null = null
  private mapperState: ClaudeMapperState = createClaudeMapperState()
  private capturedNativeSessionId: string | null = null
  /** Set by stop()/interrupt() before the transport is told to cancel — the
   *  one signal that distinguishes "the user asked for this" (turn_cancelled)
   *  from a genuine crash (turn_exited/turn_failed). */
  private userCausedExit = false
  private currentTurnId = ''
  private pendingModelId: string | null = null
  /** Read once from ctx at construction — session-service constructs a
   *  fresh handle every turn (see sendPrompt), so this is always the
   *  freshest Settings → Agents value, unlike pendingModelId's live-only
   *  mechanism. No setReasoningEffort() on the handle: changing it is
   *  always via Settings persistence + this ctx read on the next turn,
   *  the same robust mechanism Codex's reasoning effort uses. */
  private currentReasoningEffort: string | null
  private readonly eventListeners = new Set<(event: AgentEvent) => void>()
  private readonly exitListeners = new Set<(info: ProcessExitInfo) => void>()
  /** interactionId -> resolver for a pending canUseTool call (ordinary
   *  tool permission) or a pending AskUserQuestion sub-question. Both are
   *  answered the same way from the renderer's point of view
   *  (respondToInteraction(interactionId, optionId)), so one map serves
   *  both — the resolver closure knows which kind it is. */
  private readonly pendingInteractions = new Map<string, (optionId: string) => void>()

  constructor(private readonly ctx: AgentRunContext) {
    this.currentReasoningEffort = ctx.reasoningEffort
  }

  get isRunning(): boolean {
    return this.transport?.isRunning ?? false
  }

  send(prompt: string, turnId: string): void {
    this.userCausedExit = false
    this.currentTurnId = turnId
    this.mapperState = createClaudeMapperState()

    if (!this.transport) {
      const transport = new ClaudeAgentSdkTransport({
        cwd: this.ctx.workspacePath,
        executablePath: this.ctx.executablePath,
        permissionMode: this.ctx.permissionMode,
        nativeSessionId: this.ctx.nativeSessionId,
        modelId: this.pendingModelId,
        effortLevel: this.currentReasoningEffort,
        canUseTool: this.buildCanUseTool()
      })
      this.pendingModelId = null
      this.transport = transport

      transport.onMessage((msg) => this.handleMessage(msg))

      transport.onExit((info) => {
        if (!this.mapperState.sawResult) {
          if (this.userCausedExit) {
            this.emit({ type: 'turn_cancelled', sessionId: this.ctx.session.id, turnId: this.currentTurnId })
          } else {
            const reason = info.errored && info.reason
              ? `Claude exited unexpectedly: ${info.reason}`
              : 'Claude exited unexpectedly (connection lost) without completing this turn.'
            this.emit({ type: 'turn_exited', sessionId: this.ctx.session.id, turnId: this.currentTurnId, reason })
          }
        }
        for (const listener of this.exitListeners) listener({ exitCode: info.errored ? 1 : 0, signal: null })
      })
    }

    this.transport.start(prompt)
  }

  private handleMessage(msg: SDKMessage): void {
    const obj = msg as unknown as Record<string, unknown>

    // A `result` that followed a user-initiated stop()/interrupt() is a
    // cancellation, not a failure — even though the SDK reports it as
    // `is_error: true` with an error subtype (confirmed live:
    // `error_during_execution` after calling Query.interrupt()). Intercept
    // it here rather than in the mapper (a pure function with no knowledge
    // of *why* the turn ended) so a stopped turn never renders as a
    // fabricated crash.
    if (obj.type === 'result' && obj.is_error === true && this.userCausedExit) {
      this.mapperState = { ...this.mapperState, sawResult: true }
      this.emit({ type: 'turn_cancelled', sessionId: this.ctx.session.id, turnId: this.currentTurnId })
      return
    }

    const { events, state, capturedSessionId } = ClaudeEventMapper.mapMessage(obj, this.mapperState, this.ctx.session.id, this.currentTurnId)
    this.mapperState = state
    if (capturedSessionId) this.capturedNativeSessionId = capturedSessionId
    for (const event of events) {
      // model_info's `model` field is a real echo from system/init — the
      // CLI has no equivalent echo for the active effort level, so
      // reasoningEffort is reported here as exactly what this turn was
      // told to use (this.currentReasoningEffort), the same honest
      // "not a guess, just not an echo" treatment Codex's model_info uses.
      if (event.type === 'model_info' && this.currentReasoningEffort) {
        this.emit({ ...event, reasoningEffort: this.currentReasoningEffort })
      } else {
        this.emit(event)
      }
    }
  }

  private buildCanUseTool(): CanUseTool {
    return async (toolName, input, opts) => {
      if (toolName === ASK_USER_QUESTION_TOOL) {
        return this.handleAskUserQuestion(input, opts.toolUseID, opts.signal)
      }
      return this.handlePermissionRequest(toolName, input, opts)
    }
  }

  private handlePermissionRequest(
    toolName: string,
    input: Record<string, unknown>,
    opts: { toolUseID: string; title?: string; displayName?: string; description?: string; signal: AbortSignal }
  ): Promise<PermissionResult> {
    const interactionId = opts.toolUseID
    const prompt = opts.title ?? `Claude wants to use ${opts.displayName ?? toolName}.`
    const options: AgentChoice[] = [
      { id: 'allow', label: 'Allow' },
      { id: 'deny', label: 'Deny' }
    ]

    this.emit({
      sessionId: this.ctx.session.id,
      turnId: this.currentTurnId,
      type: 'interaction_required',
      interaction: { kind: 'permission', interactionId, prompt, options }
    })

    return new Promise<PermissionResult>((resolve) => {
      const onAbort = (): void => {
        this.pendingInteractions.delete(interactionId)
        resolve({ behavior: 'deny', message: 'Interrupted by the user before a decision was made.' })
      }
      opts.signal.addEventListener('abort', onAbort, { once: true })
      this.pendingInteractions.set(interactionId, (optionId) => {
        opts.signal.removeEventListener('abort', onAbort)
        if (optionId === 'allow') resolve({ behavior: 'allow', updatedInput: input })
        else resolve({ behavior: 'deny', message: 'The user denied this action in AgentDock.' })
      })
    })
  }

  /** AskUserQuestion carries 1-4 questions in one tool call. Each is
   *  presented as its own interaction_required (kind: 'choice') in
   *  sequence — the existing InteractionCard/AgentChoice model is
   *  single-question, so a multi-question form is answered one question at
   *  a time rather than requiring new UI. Once every question has an
   *  answer, they're delivered back together via `updatedInput.answers`,
   *  keyed by question text — the exact shape AskUserQuestionInput
   *  documents ("User answers collected by the permission component"). */
  private async handleAskUserQuestion(input: Record<string, unknown>, toolUseId: string, signal: AbortSignal): Promise<PermissionResult> {
    const questions = Array.isArray(input.questions) ? (input.questions as AskUserQuestionEntry[]) : []
    if (questions.length === 0) return { behavior: 'allow', updatedInput: input }

    const answers: Record<string, string> = {}

    for (let i = 0; i < questions.length; i++) {
      const question = questions[i]
      const interactionId = `${toolUseId}:q${i}`
      const options: AgentChoice[] = (question.options ?? []).map((o) => ({ id: o.label, label: o.label, description: o.description }))

      this.emit({
        sessionId: this.ctx.session.id,
        turnId: this.currentTurnId,
        type: 'interaction_required',
        interaction: { kind: 'choice', interactionId, prompt: question.question, options }
      })

      const chosen = await new Promise<string | null>((resolve) => {
        if (signal.aborted) {
          resolve(null)
          return
        }
        const onAbort = (): void => {
          this.pendingInteractions.delete(interactionId)
          resolve(null)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        this.pendingInteractions.set(interactionId, (optionId) => {
          signal.removeEventListener('abort', onAbort)
          resolve(optionId)
        })
      })

      if (chosen === null) {
        return { behavior: 'deny', message: 'Interrupted by the user before all questions were answered.' }
      }
      answers[question.question] = chosen
    }

    return { behavior: 'allow', updatedInput: { ...input, answers } }
  }

  write(): void {
    console.warn('[claude] write() is a no-op — the SDK transport has no PTY to write into')
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
    // Never fires — Claude sessions have no PTY/raw screen to relay, and
    // the Terminal drawer is hidden for structuredOutput agents.
    return () => {}
  }

  onProcessExit(cb: (info: ProcessExitInfo) => void): () => void {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }

  respondToInteraction(interactionId: string, optionId: string): void {
    const resolver = this.pendingInteractions.get(interactionId)
    if (!resolver) {
      console.warn(`[claude] respondToInteraction: no pending interaction for ${interactionId} (already answered, or stale)`)
      return
    }
    this.pendingInteractions.delete(interactionId)
    resolver(optionId)
  }

  setModel(modelId: string): void {
    if (this.transport) {
      // Real, live model switch — Query.setModel() is only meaningful in
      // streaming-input mode, which this transport always uses.
      this.transport.setModel(modelId)
    } else {
      // No turn has started yet; applied when the first query spawns.
      this.pendingModelId = modelId
    }
  }

  setPermissionMode(mode: string): void {
    this.transport?.setPermissionMode(mode)
  }

  runCommand(): void {
    console.warn('[claude] runCommand() is unsupported — no confirmed native command equivalent for the SDK transport')
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
