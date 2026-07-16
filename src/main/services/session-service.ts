import { randomUUID } from 'node:crypto'
import type { AgentId, CreateSessionInput, Session, SessionWithMessages } from '@shared/types'
import type { AgentChoice, AgentEvent } from '@shared/events/agent-event'
import type { TraceEvent } from '@shared/events/trace-event'
import { sessionRepo } from '../db/repositories/session-repo'
import { messageRepo } from '../db/repositories/message-repo'
import { workspaceRepo } from '../db/repositories/workspace-repo'
import { getAdapter } from '../agents/adapter-registry'
import { getClaudeNativeSessionId } from '../agents/claude/ClaudeAdapter'
import type { AgentRunHandle } from '../agents/agent-adapter'
import type { ProcessExitInfo } from './pty-service'
import { settingsService } from './settings-service'
import { detectionService } from './detection-service'

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

function extractToolName(label: string): string {
  const match = label.match(/^([A-Za-z][\w]*)/)
  return match ? match[1] : label
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

  async sendPrompt(sessionId: string, text: string): Promise<void> {
    const session = sessionRepo.get(sessionId)
    if (!session) throw new Error('Session not found.')

    messageRepo.add(sessionId, 'user', { kind: 'text', text })
    sessionRepo.setStatus(sessionId, 'running')

    let run = running.get(sessionId)

    // Reuse the existing live process for this session — only spawn a new
    // one if there's genuinely nothing running yet (first turn, or the
    // previous process already exited on its own).
    if (!run || !run.handle.isRunning) {
      const settings = settingsService.get()
      const agentSettings = settings.agents[session.agentId]
      const detection = await detectionService.detect(session.agentId, agentSettings.customPath)
      if (!detection.installed || !detection.executablePath) {
        const message = detection.error ?? `${agentDisplay(session.agentId)} is not installed.`
        messageRepo.add(sessionId, 'error', { kind: 'text', text: message })
        broadcastEvent(sessionId, { type: 'error', message })
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
        executablePath: detection.executablePath
      })

      const runState: RunningSession = { handle, unsubscribe: () => {}, hadError: false }

      const unsubscribeEvent = handle.onEvent((event) => {
        switch (event.type) {
          case 'assistant_message':
            // Classifiers emit one assistant_message per settled reply —
            // the closest available proxy for "this turn is done" since the
            // CLI is a long-lived process rather than a one-shot invocation
            // with a real exit per turn.
            messageRepo.add(sessionId, 'assistant', { kind: 'text', text: event.text })
            broadcastEvent(sessionId, event)
            sessionRepo.setStatus(sessionId, 'idle')
            return
          case 'tool_activity': {
            const tool = extractToolName(event.label)
            messageRepo.add(sessionId, 'assistant', {
              kind: 'activity',
              tool,
              summary: event.status === 'error' ? `${tool} failed` : `Ran ${event.label}`,
              detail: event.label,
              isError: event.status === 'error'
            })
            broadcastEvent(sessionId, event)
            return
          }
          case 'choice_required':
          case 'permission_required':
            pendingInteractions.set(sessionId, {
              interactionId: event.interactionId,
              prompt: event.prompt,
              options: event.options
            })
            broadcastEvent(sessionId, event)
            return
          case 'error':
            runState.hadError = true
            messageRepo.add(sessionId, 'error', { kind: 'text', text: event.message })
            broadcastEvent(sessionId, event)
            return
          case 'session_complete': {
            if (session.agentId === 'claude-code') {
              const nativeId = getClaudeNativeSessionId(handle)
              if (nativeId) sessionRepo.setNativeSessionId(sessionId, nativeId)
            }
            sessionRepo.setStatus(sessionId, runState.hadError ? 'error' : 'idle')
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
    }

    trace(sessionId, { kind: 'PTY_WRITE_REQUESTED' })
    run.handle.send(text)
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
    if (!pending || pending.interactionId !== interactionId) return

    const option = pending.options.find((o) => o.id === optionId)
    messageRepo.add(sessionId, 'system', {
      kind: 'interaction-record',
      prompt: pending.prompt,
      choiceLabel: option?.label ?? optionId
    })
    pendingInteractions.delete(sessionId)
    running.get(sessionId)?.handle.respondToInteraction(interactionId, optionId)
  },

  setModel(sessionId: string, modelId: string): void {
    running.get(sessionId)?.handle.setModel(modelId)
  },

  runCommand(sessionId: string, commandId: string): void {
    running.get(sessionId)?.handle.runCommand(commandId)
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
