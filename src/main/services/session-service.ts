import { randomUUID } from 'node:crypto'
import type { AgentId, CreateSessionInput, LaunchTerminalResult, Session, SessionWithMessages } from '@shared/types'
import type { AgentChoice, AgentEvent } from '@shared/events/agent-event'
import type { TraceEvent } from '@shared/events/trace-event'
import { sessionRepo } from '../db/repositories/session-repo'
import { messageRepo } from '../db/repositories/message-repo'
import { workspaceRepo } from '../db/repositories/workspace-repo'
import { getAdapter } from '../agents/adapter-registry'
import type { AgentRunHandle } from '../agents/agent-adapter'
import type { ProcessExitInfo } from './pty-service'
import { settingsService } from './settings-service'
import { detectionService } from './detection-service'
import { launchExternalTerminal } from './external-terminal-service'

interface RunningSession {
  handle: AgentRunHandle
  unsubscribe: () => void
  hadError: boolean
}

interface PendingInteraction {
  interactionId: string
  prompt: string
  options: AgentChoice[]
}

export interface SessionEventPayload {
  event: AgentEvent
  sequence: number
  eventId: string
}

const running = new Map<string, RunningSession>()
const eventListeners = new Map<string, Set<(payload: SessionEventPayload) => void>>()
const terminalListeners = new Map<string, Set<(data: string) => void>>()
const terminalExitListeners = new Map<string, Set<(info: { exitCode: number | null; signal: string | null }) => void>>()
const traceListeners = new Map<string, Set<(trace: TraceEvent) => void>>()
const pendingInteractions = new Map<string, PendingInteraction>()
/** Per-session monotonic counter backing SessionEventEnvelope.sequence — lets
 *  the renderer store detect a duplicate/out-of-order redelivery. Assigned
 *  here, once, at the single point every event is broadcast from. */
const sequenceCounters = new Map<string, number>()
/** The last Codex model id that genuinely completed a turn successfully —
 *  used to revert Settings → Agents' saved model choice if the user picks
 *  one Codex ends up rejecting (see the turn_failed case below), so a bad
 *  selection doesn't stick for future turns/sessions. In-memory only
 *  (resets on app restart); the persisted setting itself is the durable
 *  source of truth once a model is confirmed working. */
let lastGoodCodexModel: string | null = null

function broadcastEvent(sessionId: string, event: AgentEvent): void {
  trace(sessionId, { kind: 'TRANSLATED_EVENT_EMITTED', detail: event.type })
  const sequence = (sequenceCounters.get(sessionId) ?? 0) + 1
  sequenceCounters.set(sessionId, sequence)
  const payload: SessionEventPayload = { event, sequence, eventId: randomUUID() }
  const listeners = eventListeners.get(sessionId)
  if (listeners) for (const l of listeners) l(payload)
}

function broadcastTerminal(sessionId: string, data: string): void {
  const listeners = terminalListeners.get(sessionId)
  if (listeners) for (const l of listeners) l(data)
}

function trace(sessionId: string, entry: Omit<TraceEvent, 'sessionId' | 'timestamp'>): void {
  const listeners = traceListeners.get(sessionId)
  if (!listeners || listeners.size === 0) return
  const full: TraceEvent = { ...entry, sessionId, timestamp: Date.now() }
  for (const l of listeners) l(full)
}

export const sessionService = {
  create(input: CreateSessionInput): Session {
    const title = input.title?.trim() || `New ${agentDisplay(input.agentId)} session`
    return sessionRepo.create(input.workspaceId, input.agentId, title)
  },

  list(workspaceId: string): Session[] {
    return sessionRepo.listByWorkspace(workspaceId)
  },

  get(sessionId: string): SessionWithMessages | null {
    const session = sessionRepo.get(sessionId)
    if (!session) return null
    return { ...session, messages: messageRepo.listBySession(sessionId) }
  },

  async sendPrompt(sessionId: string, text: string, turnId: string): Promise<void> {
    const session = sessionRepo.get(sessionId)
    if (!session) throw new Error('Session not found.')

    messageRepo.add(sessionId, 'user', { kind: 'text', text })
    sessionRepo.setStatus(sessionId, 'running')

    let run = running.get(sessionId)

    // Reuse the existing live process for this session — only spawn a new
    // one if there's genuinely nothing running yet. Claude's SDK-backed
    // query and Antigravity's PTY both stay live across turns; only Codex's
    // one-shot `exec` process has already exited by the time the next
    // prompt arrives, so it alone spawns fresh every turn.
    if (!run || !run.handle.isRunning) {
      const settings = settingsService.get()
      const agentSettings = settings.agents[session.agentId]
      const detection = await detectionService.detect(session.agentId, agentSettings.customPath)
      if (!detection.installed || !detection.executablePath) {
        const message = detection.error ?? `${agentDisplay(session.agentId)} is not installed.`
        messageRepo.add(sessionId, 'error', { kind: 'text', text: message })
        broadcastEvent(sessionId, { type: 'turn_failed', sessionId, turnId, reason: message })
        sessionRepo.setStatus(sessionId, 'error')
        // Throw (rather than silently returning) so the IPC call this is
        // behind actually rejects — otherwise the renderer has no way to
        // know delivery failed and would wrongly mark the user's message as
        // successfully sent.
        throw new Error(message)
      }

      const adapter = getAdapter(session.agentId)
      const handle = adapter.start({
        session,
        workspacePath: workspacePathFor(session.workspaceId),
        nativeSessionId: sessionRepo.getNativeSessionId(sessionId),
        permissionMode: agentSettings.permissionMode,
        executablePath: detection.executablePath,
        model: agentSettings.model,
        reasoningEffort: agentSettings.reasoningEffort
      })

      const runState: RunningSession = { handle, unsubscribe: () => {}, hadError: false }

      const unsubscribeEvent = handle.onEvent((event) => {
        switch (event.type) {
          case 'assistant_completed':
            messageRepo.add(sessionId, 'assistant', { kind: 'text', text: event.text })
            broadcastEvent(sessionId, event)
            return
          case 'activity_completed': {
            // Only the settled outcome is persisted — activity_started/
            // updated are live-only signals (transient "in progress" state
            // has no meaningful persisted representation, same as the old
            // model never persisted a 'running' tool_activity).
            const tool = event.tool ?? event.label
            messageRepo.add(sessionId, 'assistant', {
              kind: 'activity',
              tool,
              summary: event.summary ?? (event.status === 'error' ? `${tool} failed` : `Ran ${event.label}`),
              detail: event.label,
              isError: event.status === 'error',
              richDetail: event.detail
            })
            broadcastEvent(sessionId, event)
            return
          }
          case 'interaction_required': {
            const interaction = event.interaction
            if (interaction.kind === 'choice' || interaction.kind === 'permission') {
              pendingInteractions.set(sessionId, {
                interactionId: interaction.interactionId,
                prompt: interaction.prompt,
                options: interaction.options
              })
            }
            // 'choice' covers both a genuine yes/no-style confirmation and
            // AskUserQuestion — both are "Claude is waiting on the user to
            // answer something", not "waiting for a permission decision".
            sessionRepo.setStatus(sessionId, interaction.kind === 'permission' ? 'waiting_for_permission' : 'waiting_for_user')
            trace(sessionId, { kind: 'INTERACTION_REQUIRED', detail: interaction.kind })
            broadcastEvent(sessionId, event)
            return
          }
          case 'turn_completed':
          case 'turn_failed': {
            const nativeId = handle.getNativeSessionId()
            if (nativeId) sessionRepo.setNativeSessionId(sessionId, nativeId)
            if (event.type === 'turn_failed') {
              runState.hadError = true
              messageRepo.add(sessionId, 'error', { kind: 'text', text: event.reason })
              // Codex names the rejected model directly in its own error
              // text (confirmed live: "The 'X' model is not supported when
              // using Codex with a ChatGPT account.") — if that's what just
              // failed, don't leave a known-broken model selected for the
              // next turn/session; fall back to the last model that
              // genuinely worked and let the header reflect it immediately.
              if (
                session.agentId === 'codex' &&
                agentSettings.model &&
                lastGoodCodexModel &&
                lastGoodCodexModel !== agentSettings.model &&
                event.reason.toLowerCase().includes(agentSettings.model.toLowerCase())
              ) {
                settingsService.update({ agents: { codex: { model: lastGoodCodexModel } } })
                broadcastEvent(sessionId, { type: 'model_info', sessionId, turnId: event.turnId, model: lastGoodCodexModel })
              }
            } else if (session.agentId === 'codex' && agentSettings.model) {
              lastGoodCodexModel = agentSettings.model
            }
            sessionRepo.setStatus(sessionId, event.type === 'turn_failed' || runState.hadError ? 'error' : 'idle')
            running.delete(sessionId)
            pendingInteractions.delete(sessionId)
            broadcastEvent(sessionId, event)
            return
          }
          // A user-initiated Stop/Interrupt — distinct from turn_failed so
          // the UI never renders a cancellation as a fabricated crash.
          case 'turn_cancelled': {
            const nativeId = handle.getNativeSessionId()
            if (nativeId) sessionRepo.setNativeSessionId(sessionId, nativeId)
            sessionRepo.setStatus(sessionId, 'cancelled')
            running.delete(sessionId)
            pendingInteractions.delete(sessionId)
            broadcastEvent(sessionId, event)
            return
          }
          // The process/query ended unexpectedly (crash, killed externally,
          // connection lost) with no result and no user-initiated stop.
          case 'turn_exited': {
            const nativeId = handle.getNativeSessionId()
            if (nativeId) sessionRepo.setNativeSessionId(sessionId, nativeId)
            runState.hadError = true
            messageRepo.add(sessionId, 'error', { kind: 'text', text: event.reason })
            sessionRepo.setStatus(sessionId, 'exited')
            running.delete(sessionId)
            pendingInteractions.delete(sessionId)
            broadcastEvent(sessionId, event)
            return
          }
          default:
            broadcastEvent(sessionId, event)
        }
      })

      const unsubscribeRaw = handle.onRawData((data) => {
        broadcastTerminal(sessionId, data)
        trace(sessionId, { kind: 'PTY_OUTPUT_RECEIVED', detail: `${data.length}b` })
      })
      const unsubscribeExit = handle.onProcessExit((info: ProcessExitInfo) => {
        const listeners = terminalExitListeners.get(sessionId)
        if (listeners) for (const l of listeners) l({ exitCode: info.exitCode, signal: info.signal != null ? String(info.signal) : null })
      })

      runState.unsubscribe = () => {
        unsubscribeEvent()
        unsubscribeRaw()
        unsubscribeExit()
      }
      running.set(sessionId, runState)
      run = runState
    } else {
      console.log(`[session] reusing live process for session ${sessionId}`)
      // The process/query was already running when this turn started, so
      // it never picked up a permission-mode change made via Settings in
      // between turns — apply it live if the adapter supports that
      // (Claude's SDK-backed Query does; see capability-registry.ts).
      const settings = settingsService.get()
      run.handle.setPermissionMode?.(settings.agents[session.agentId].permissionMode)
    }

    trace(sessionId, { kind: 'PTY_WRITE_REQUESTED' })
    run.handle.send(text, turnId)
    trace(sessionId, { kind: 'PTY_WRITE_SUCCEEDED' })
  },

  respondToInteraction(sessionId: string, interactionId: string, optionId: string): void {
    const pending = pendingInteractions.get(sessionId)
    // If this interaction is already gone (answered once already, or never
    // matched what's actually pending) this must be a stale/duplicate
    // submission — a double-click, or a UI race between the renderer's
    // optimistic clear and this IPC call landing. Skip the PTY write too,
    // not just the message record, so a second click can't re-send input
    // (e.g. a second "y\r" or a second arrow-menu overshoot) into the live
    // CLI once the interaction has already been consumed.
    if (!pending || pending.interactionId !== interactionId) {
      trace(sessionId, { kind: 'INTERACTION_STALE_OR_DUPLICATE', detail: interactionId })
      return
    }

    // Deliver the decision to the live handle FIRST, and only mark the
    // interaction resolved (record it, clear it, return the session to
    // 'running') if that actually succeeds — a failed/throwing delivery
    // must leave the prompt visible and pending rather than silently
    // dropping the user's answer.
    try {
      running.get(sessionId)?.handle.respondToInteraction(interactionId, optionId)
    } catch (err) {
      console.error(`[session] respondToInteraction delivery failed for ${sessionId}/${interactionId}`, err)
      return
    }

    const option = pending.options.find((o) => o.id === optionId)
    messageRepo.add(sessionId, 'system', {
      kind: 'interaction-record',
      prompt: pending.prompt,
      choiceLabel: option?.label ?? optionId
    })
    pendingInteractions.delete(sessionId)
    sessionRepo.setStatus(sessionId, 'running')
    trace(sessionId, { kind: 'INTERACTION_RESPONDED', detail: optionId })
  },

  setModel(sessionId: string, modelId: string): void {
    running.get(sessionId)?.handle.setModel(modelId)
  },

  runCommand(sessionId: string, commandId: string): void {
    running.get(sessionId)?.handle.runCommand(commandId)
  },

  /** Opens a brand-new, independent interactive terminal in the session's
   *  workspace — never a reattachment to the live process backing this
   *  session (no such reattachment exists; see external-terminal-service.ts). */
  async openExternalTerminal(sessionId: string): Promise<LaunchTerminalResult> {
    const session = sessionRepo.get(sessionId)
    if (!session) throw new Error('Session not found.')

    const settings = settingsService.get()
    const agentSettings = settings.agents[session.agentId]
    const detection = await detectionService.detect(session.agentId, agentSettings.customPath)
    if (!detection.installed || !detection.executablePath) {
      const error = detection.error ?? `${agentDisplay(session.agentId)} is not installed.`
      return { launched: false, method: null, command: '', error }
    }

    return launchExternalTerminal({
      agentId: session.agentId,
      executablePath: detection.executablePath,
      workspacePath: workspacePathFor(session.workspaceId),
      permissionMode: agentSettings.permissionMode,
      nativeSessionId: sessionRepo.getNativeSessionId(sessionId)
    })
  },

  interrupt(sessionId: string): void {
    running.get(sessionId)?.handle.interrupt()
  },

  stop(sessionId: string): void {
    const run = running.get(sessionId)
    if (run) {
      run.handle.stop()
      run.unsubscribe()
      running.delete(sessionId)
    }
    pendingInteractions.delete(sessionId)
    sessionRepo.setStatus(sessionId, 'stopped')
  },

  delete(sessionId: string): void {
    this.stop(sessionId)
    sessionRepo.delete(sessionId)
    eventListeners.delete(sessionId)
    terminalListeners.delete(sessionId)
    terminalExitListeners.delete(sessionId)
    traceListeners.delete(sessionId)
    sequenceCounters.delete(sessionId)
  },

  onEvent(sessionId: string, cb: (payload: SessionEventPayload) => void): () => void {
    const set = eventListeners.get(sessionId) ?? new Set()
    set.add(cb)
    eventListeners.set(sessionId, set)
    return () => set.delete(cb)
  },

  onTrace(sessionId: string, cb: (trace: TraceEvent) => void): () => void {
    const set = traceListeners.get(sessionId) ?? new Set()
    set.add(cb)
    traceListeners.set(sessionId, set)
    return () => set.delete(cb)
  },

  onTerminalData(sessionId: string, cb: (data: string) => void): () => void {
    const set = terminalListeners.get(sessionId) ?? new Set()
    set.add(cb)
    terminalListeners.set(sessionId, set)
    return () => set.delete(cb)
  },

  onTerminalExit(sessionId: string, cb: (info: { exitCode: number | null; signal: string | null }) => void): () => void {
    const set = terminalExitListeners.get(sessionId) ?? new Set()
    set.add(cb)
    terminalExitListeners.set(sessionId, set)
    return () => set.delete(cb)
  },

  writeTerminal(sessionId: string, data: string): void {
    running.get(sessionId)?.handle.write(data)
  },

  resizeTerminal(sessionId: string, cols: number, rows: number): void {
    running.get(sessionId)?.handle.resize(cols, rows)
  },

  isRunning(sessionId: string): boolean {
    return running.get(sessionId)?.handle.isRunning ?? false
  }
}

function workspacePathFor(workspaceId: string): string {
  const workspace = workspaceRepo.get(workspaceId)
  if (!workspace) throw new Error('Workspace not found.')
  return workspace.path
}

function agentDisplay(agentId: AgentId): string {
  return { 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' }[agentId]
}
