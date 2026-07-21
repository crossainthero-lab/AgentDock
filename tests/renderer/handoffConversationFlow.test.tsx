// Regression coverage for the "continued agent response is blank" bug.
//
// Two distinct, real root causes were found and fixed:
//
// 1. handoff-service.ts used to send the new session's first prompt itself,
//    server-side, inventing its own turnId via randomUUID() — a turnId the
//    renderer never learned. Every AgentEvent is turn-scoped
//    (AgentEventReducer.isForActiveTurn requires `state.turn.id ===
//    event.turnId`), and `state.turn` is only ever set by the renderer's own
//    beginSend(). A turn the renderer never began could never be matched, so
//    every event for it — including the final completion — was silently
//    rejected as stale_turn. Fixed by having handoff-service only create the
//    session and return the prompt text; HandoffDialog now sends it through
//    conversationStore.sendPrompt(), the same turnId-owning path every other
//    message uses (see handoff-service.ts's own module comment).
//
// 2. Once (1) was fixed, a SECOND race surfaced: conversationStore's
//    one-time persisted-history seed fetch is kicked off the first time
//    ensureTracked() runs for a session — which, for a handoff session, is
//    now the very first line of sendPrompt() itself, called before
//    SessionView ever mounts. If that fetch (which sees an empty message
//    list, since the session is brand new) resolves AFTER beginSend() has
//    already opened a turn, it used to unconditionally overwrite
//    `entry.reducer` with a blank seeded state — wiping the freshly-opened
//    turn back to null, silently, without the send() call ever failing. Any
//    event for that turn was then rejected the same way as bug (1). Fixed
//    with a version guard in conversationStore.ts: the seed only applies if
//    nothing has mutated the entry since the fetch was kicked off.
//
// Both were confirmed against the REAL app (see AgentDock's handoff E2E
// runs) — not just theorized — before being fixed.
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDockApi, SessionEventPayload } from '../../src/shared/preload-api'
import type { AgentEvent } from '../../src/shared/events/agent-event'
import type { SessionWithMessages } from '../../src/shared/types'
import { useSessionConversation } from '../../src/renderer/state/useSessionConversation'
import { __resetAllForTests, sendPrompt as storeSendPrompt } from '../../src/renderer/state/conversationStore'

const SOURCE_SESSION = 'source-session'
const CONTINUED_SESSION = 'continued-session'

function makeSession(id: string): SessionWithMessages {
  return {
    id,
    workspaceId: 'w1',
    agentId: 'codex',
    title: 'Continued session',
    status: 'running',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    messages: []
  }
}

describe('handoff conversation flow (conversationStore + turnId ownership)', () => {
  let eventListeners: Map<string, Set<(payload: SessionEventPayload) => void>>
  let attachCounts: Map<string, number>
  let sendPromptCalls: Array<[string, string, string]>
  let getResolvers: Map<string, Array<(v: SessionWithMessages | null) => void>>
  let deferGet: boolean

  beforeEach(() => {
    __resetAllForTests()
    eventListeners = new Map()
    attachCounts = new Map()
    sendPromptCalls = []
    getResolvers = new Map()
    deferGet = false

    const api: Partial<AgentDockApi> = {
      session: {
        create: vi.fn(),
        list: vi.fn(),
        get(sessionId) {
          if (!deferGet) return Promise.resolve(makeSession(sessionId))
          return new Promise((resolve) => {
            const list = getResolvers.get(sessionId) ?? []
            list.push(resolve)
            getResolvers.set(sessionId, list)
          })
        },
        async sendPrompt(sessionId, text, turnId) {
          sendPromptCalls.push([sessionId, text, turnId])
        },
        async interrupt() {},
        async stop() {},
        async delete() {},
        onEvent(sessionId, cb) {
          const set = eventListeners.get(sessionId) ?? new Set()
          set.add(cb)
          eventListeners.set(sessionId, set)
          attachCounts.set(sessionId, (attachCounts.get(sessionId) ?? 0) + 1)
          return () => set.delete(cb)
        },
        onTrace() {
          return () => {}
        },
        async respondToInteraction() {},
        async setModel() {},
        async runCommand() {}
      }
    }
    ;(window as unknown as { agentDock: AgentDockApi }).agentDock = api as AgentDockApi
  })

  afterEach(() => {
    delete (window as unknown as { agentDock?: AgentDockApi }).agentDock
  })

  function emit(sessionId: string, event: Omit<AgentEvent, 'sessionId' | 'turnId'>, sequence: number, turnId: string): void {
    const listeners = eventListeners.get(sessionId)
    if (!listeners) return
    const payload: SessionEventPayload = { event: { ...event, sessionId, turnId } as AgentEvent, sequence, eventId: `evt-${sessionId}-${sequence}` }
    for (const l of listeners) l(payload)
  }

  function lastTurnIdFor(sessionId: string): string {
    const call = [...sendPromptCalls].reverse().find((c) => c[0] === sessionId)
    if (!call) throw new Error(`no sendPrompt call recorded for ${sessionId}`)
    return call[2]
  }

  it('handoff-style send (store-initiated, before any component mounts) uses a turnId the reducer accepts, and the streamed response renders in the new open conversation', async () => {
    // Mirrors HandoffDialog.submit(): the prompt is sent directly through
    // the store, before selectSession()/SessionView ever mounts this session.
    void storeSendPrompt(CONTINUED_SESSION, 'codex', 'continuation prompt')

    // The session then opens (SessionView mounts, same as onCompleted -> selectSession).
    const { result } = renderHook(() => useSessionConversation(CONTINUED_SESSION))
    await waitFor(() => expect(result.current.loading).toBe(false))

    // The user's own continuation prompt renders immediately, optimistically.
    expect(result.current.items.find((i) => i.kind === 'user')).toMatchObject({ text: 'continuation prompt' })

    const turnId = lastTurnIdFor(CONTINUED_SESSION)
    act(() => emit(CONTINUED_SESSION, { type: 'assistant_delta', messageId: 'm1', textDelta: 'Real, non-blank reply' }, 1, turnId))
    act(() => emit(CONTINUED_SESSION, { type: 'turn_completed' }, 2, turnId))

    // CRITICAL: the completed response is not blank.
    const assistantItems = result.current.items.filter((i) => i.kind === 'assistant')
    expect(assistantItems).toHaveLength(1)
    expect(assistantItems[0]).toMatchObject({ text: 'Real, non-blank reply' })
    expect(result.current.isBusy).toBe(false)
  })

  it('a late-resolving empty seed fetch does not clobber a turn already begun by a handoff-style send', async () => {
    deferGet = true
    void storeSendPrompt(CONTINUED_SESSION, 'codex', 'continuation prompt')

    const { result } = renderHook(() => useSessionConversation(CONTINUED_SESSION))
    expect(result.current.items.find((i) => i.kind === 'user')).toMatchObject({ text: 'continuation prompt' })

    // The seed fetch (kicked off by sendPrompt's own ensureTracked call)
    // resolves late, with an empty persisted list — a brand-new session
    // genuinely has none yet.
    act(() => {
      for (const resolve of getResolvers.get(CONTINUED_SESSION) ?? []) resolve(makeSession(CONTINUED_SESSION))
    })
    await waitFor(() => expect(result.current.loading).toBe(false))

    // The optimistic message must survive the late seed.
    expect(result.current.items.find((i) => i.kind === 'user')).toMatchObject({ text: 'continuation prompt' })

    // Streamed chunks are committed before completion, in order, and
    // finalisation does not overwrite them with an empty payload.
    const turnId = lastTurnIdFor(CONTINUED_SESSION)
    act(() => emit(CONTINUED_SESSION, { type: 'assistant_delta', messageId: 'm1', textDelta: 'Hello' }, 1, turnId))
    act(() => emit(CONTINUED_SESSION, { type: 'assistant_delta', messageId: 'm1', textDelta: ' world' }, 2, turnId))
    act(() => emit(CONTINUED_SESSION, { type: 'assistant_completed', messageId: 'm1', text: 'Hello world' }, 3, turnId))
    act(() => emit(CONTINUED_SESSION, { type: 'turn_completed' }, 4, turnId))

    const assistantItems = result.current.items.filter((i) => i.kind === 'assistant')
    expect(assistantItems).toHaveLength(1)
    expect(assistantItems[0]).toMatchObject({ text: 'Hello world' })
    expect(result.current.isBusy).toBe(false)
  })

  it('output from the continued session never leaks into the original source session', async () => {
    const source = renderHook(() => useSessionConversation(SOURCE_SESSION))
    await waitFor(() => expect(source.result.current.loading).toBe(false))

    void storeSendPrompt(CONTINUED_SESSION, 'codex', 'continuation prompt')
    const continued = renderHook(() => useSessionConversation(CONTINUED_SESSION))
    await waitFor(() => expect(continued.result.current.loading).toBe(false))

    const turnId = lastTurnIdFor(CONTINUED_SESSION)
    act(() => emit(CONTINUED_SESSION, { type: 'assistant_delta', messageId: 'm1', textDelta: 'Only for the continued session' }, 1, turnId))
    act(() => emit(CONTINUED_SESSION, { type: 'turn_completed' }, 2, turnId))

    expect(continued.result.current.items.filter((i) => i.kind === 'assistant')).toEqual([
      expect.objectContaining({ text: 'Only for the continued session' })
    ])
    expect(source.result.current.items.filter((i) => i.kind === 'assistant')).toHaveLength(0)
    expect(source.result.current.items.filter((i) => i.kind === 'user')).toHaveLength(0)
  })

  it('navigating between two continued sessions does not duplicate listeners or messages', async () => {
    void storeSendPrompt(CONTINUED_SESSION, 'codex', 'first continuation')
    const otherContinued = 'continued-session-2'
    void storeSendPrompt(otherContinued, 'antigravity', 'second continuation')

    const { rerender } = renderHook(({ sessionId }: { sessionId: string }) => useSessionConversation(sessionId), {
      initialProps: { sessionId: CONTINUED_SESSION }
    })
    await waitFor(() => expect(attachCounts.get(CONTINUED_SESSION)).toBe(1))

    rerender({ sessionId: otherContinued })
    await waitFor(() => expect(attachCounts.get(otherContinued)).toBe(1))

    rerender({ sessionId: CONTINUED_SESSION })
    rerender({ sessionId: otherContinued })
    rerender({ sessionId: CONTINUED_SESSION })

    expect(attachCounts.get(CONTINUED_SESSION)).toBe(1)
    expect(attachCounts.get(otherContinued)).toBe(1)
  })
})
