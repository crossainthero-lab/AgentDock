// Regression coverage for the "agent response saved but not shown until
// another action" bug. Root cause: the old per-mount reducer state was
// wiped and reseeded from persisted messages every time a session was
// (re)mounted — including switching back to a session whose turn was still
// in flight — which permanently orphaned that turn (AgentEventReducer's
// isForActiveTurn guard never matched again, so every remaining event,
// including the final turn_completed, was dropped as "stale_turn"). The fix
// moves live reducer state into conversationStore.ts, a module-level
// singleton keyed by sessionId that survives component unmount/remount —
// see that file's module comment for the full story.
import React from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDockApi, SessionEventPayload } from '../../src/shared/preload-api'
import type { AgentEvent } from '../../src/shared/events/agent-event'
import type { SessionWithMessages } from '../../src/shared/types'
import { useSessionConversation } from '../../src/renderer/state/useSessionConversation'
import { __resetAllForTests } from '../../src/renderer/state/conversationStore'

const SESSION_A = 'session-a'
const SESSION_B = 'session-b'

function makeSession(id: string): SessionWithMessages {
  return {
    id,
    workspaceId: 'w1',
    agentId: 'claude-code',
    title: 'Test session',
    status: 'idle',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    messages: []
  }
}

describe('conversationStore (via useSessionConversation)', () => {
  let eventListeners: Map<string, Set<(payload: SessionEventPayload) => void>>
  let attachCounts: Map<string, number>
  let sendPromptCalls: Array<[string, string, string]>
  let persisted: Map<string, SessionWithMessages>

  beforeEach(() => {
    __resetAllForTests()
    eventListeners = new Map()
    attachCounts = new Map()
    sendPromptCalls = []
    persisted = new Map([
      [SESSION_A, makeSession(SESSION_A)],
      [SESSION_B, makeSession(SESSION_B)]
    ])

    const api: Partial<AgentDockApi> = {
      session: {
        create: vi.fn(),
        list: vi.fn(),
        async get(sessionId) {
          return persisted.get(sessionId) ?? null
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

  it('applies incoming agent output to the currently open conversation immediately, with no extra action required', async () => {
    const { result } = renderHook(() => useSessionConversation(SESSION_A))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => { await result.current.sendPrompt('hi') })
    const turnId = lastTurnIdFor(SESSION_A)

    act(() => emit(SESSION_A, { type: 'assistant_delta', messageId: 'm1', textDelta: 'Hi there' }, 1, turnId))

    // No second sendPrompt, no unmount/remount, no manual refresh — the
    // reply must already be in `items`.
    expect(result.current.items.find((i) => i.kind === 'assistant')).toMatchObject({ text: 'Hi there' })
  })

  it('appends multiple streamed chunks in the order they arrive', async () => {
    const { result } = renderHook(() => useSessionConversation(SESSION_A))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => { await result.current.sendPrompt('go') })
    const turnId = lastTurnIdFor(SESSION_A)

    act(() => emit(SESSION_A, { type: 'assistant_delta', messageId: 'm1', textDelta: 'One' }, 1, turnId))
    act(() => emit(SESSION_A, { type: 'assistant_delta', messageId: 'm1', textDelta: ' Two' }, 2, turnId))
    act(() => emit(SESSION_A, { type: 'assistant_delta', messageId: 'm1', textDelta: ' Three' }, 3, turnId))

    const assistantItems = result.current.items.filter((i) => i.kind === 'assistant')
    expect(assistantItems).toHaveLength(1)
    expect(assistantItems[0]).toMatchObject({ text: 'One Two Three' })
  })

  it('does not duplicate the final response when completion follows streamed deltas', async () => {
    const { result } = renderHook(() => useSessionConversation(SESSION_A))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => { await result.current.sendPrompt('go') })
    const turnId = lastTurnIdFor(SESSION_A)

    act(() => emit(SESSION_A, { type: 'assistant_delta', messageId: 'm1', textDelta: 'Full reply' }, 1, turnId))
    act(() => emit(SESSION_A, { type: 'turn_completed' }, 2, turnId))

    const assistantItems = result.current.items.filter((i) => i.kind === 'assistant')
    expect(assistantItems).toHaveLength(1)
    expect(assistantItems[0]).toMatchObject({ text: 'Full reply' })
    expect(result.current.isBusy).toBe(false)
  })

  it('keeps two sessions fully isolated — output from one never appears in the other', async () => {
    const a = renderHook(() => useSessionConversation(SESSION_A))
    await waitFor(() => expect(a.result.current.loading).toBe(false))
    const b = renderHook(() => useSessionConversation(SESSION_B))
    await waitFor(() => expect(b.result.current.loading).toBe(false))

    await act(async () => { await a.result.current.sendPrompt('for A') })
    const turnA = lastTurnIdFor(SESSION_A)
    await act(async () => { await b.result.current.sendPrompt('for B') })
    const turnB = lastTurnIdFor(SESSION_B)

    act(() => emit(SESSION_A, { type: 'assistant_delta', messageId: 'm1', textDelta: 'Reply for A' }, 1, turnA))
    act(() => emit(SESSION_B, { type: 'assistant_delta', messageId: 'm1', textDelta: 'Reply for B' }, 1, turnB))

    expect(a.result.current.items.filter((i) => i.kind === 'assistant')).toEqual([expect.objectContaining({ text: 'Reply for A' })])
    expect(b.result.current.items.filter((i) => i.kind === 'assistant')).toEqual([expect.objectContaining({ text: 'Reply for B' })])
  })

  it('CRITICAL: a reply that keeps streaming while the user is on a different session is not lost — it is fully visible when they switch back, without sending another message', async () => {
    const { result, rerender } = renderHook(({ sessionId }: { sessionId: string }) => useSessionConversation(sessionId), {
      initialProps: { sessionId: SESSION_A }
    })
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => { await result.current.sendPrompt('go') })
    const turnId = lastTurnIdFor(SESSION_A)
    act(() => emit(SESSION_A, { type: 'assistant_delta', messageId: 'm1', textDelta: 'Hello' }, 1, turnId))

    // User switches away from A mid-turn...
    rerender({ sessionId: SESSION_B })
    await waitFor(() => expect(result.current.loading).toBe(false))

    // ...and the rest of A's turn arrives while B is the one on screen.
    act(() => emit(SESSION_A, { type: 'assistant_delta', messageId: 'm1', textDelta: ' world' }, 2, turnId))
    act(() => emit(SESSION_A, { type: 'turn_completed' }, 3, turnId))

    // ...then switches back to A, with no second message and no other
    // action beyond the switch itself.
    rerender({ sessionId: SESSION_A })
    await waitFor(() => expect(result.current.loading).toBe(false))

    const assistantItems = result.current.items.filter((i) => i.kind === 'assistant')
    expect(assistantItems).toHaveLength(1)
    expect(assistantItems[0]).toMatchObject({ text: 'Hello world' })
    expect(result.current.isBusy).toBe(false)
  })

  it('switching sessions during output corrupts neither session (no cross-talk, no duplication)', async () => {
    const { result, rerender } = renderHook(({ sessionId }: { sessionId: string }) => useSessionConversation(sessionId), {
      initialProps: { sessionId: SESSION_A }
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => { await result.current.sendPrompt('for A') })
    const turnA = lastTurnIdFor(SESSION_A)

    rerender({ sessionId: SESSION_B })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => { await result.current.sendPrompt('for B') })
    const turnB = lastTurnIdFor(SESSION_B)

    // Interleave both sessions' streams while the view keeps flipping.
    act(() => emit(SESSION_A, { type: 'assistant_delta', messageId: 'm1', textDelta: 'A1' }, 1, turnA))
    act(() => emit(SESSION_B, { type: 'assistant_delta', messageId: 'm1', textDelta: 'B1' }, 1, turnB))
    rerender({ sessionId: SESSION_A })
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => emit(SESSION_A, { type: 'assistant_delta', messageId: 'm1', textDelta: ' A2' }, 2, turnA))
    act(() => emit(SESSION_A, { type: 'turn_completed' }, 3, turnA))
    expect(result.current.items.filter((i) => i.kind === 'assistant')).toEqual([expect.objectContaining({ text: 'A1 A2' })])

    rerender({ sessionId: SESSION_B })
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => emit(SESSION_B, { type: 'assistant_delta', messageId: 'm1', textDelta: ' B2' }, 2, turnB))
    act(() => emit(SESSION_B, { type: 'turn_completed' }, 3, turnB))
    expect(result.current.items.filter((i) => i.kind === 'assistant')).toEqual([expect.objectContaining({ text: 'B1 B2' })])
  })

  it('reopening (a fresh store, as after an app restart) loads the persisted response correctly', async () => {
    persisted.set(SESSION_A, {
      ...makeSession(SESSION_A),
      messages: [
        { id: 'u1', sessionId: SESSION_A, role: 'user', content: { kind: 'text', text: 'hi' }, createdAt: new Date(1).toISOString() },
        { id: 'a1', sessionId: SESSION_A, role: 'assistant', content: { kind: 'text', text: 'Hello!' }, createdAt: new Date(2).toISOString() }
      ]
    })

    const { result } = renderHook(() => useSessionConversation(SESSION_A))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.items).toEqual([
      expect.objectContaining({ kind: 'user', text: 'hi' }),
      expect.objectContaining({ kind: 'assistant', text: 'Hello!' })
    ])
  })

  it('does not duplicate the underlying event subscription after navigating away and back', async () => {
    const { rerender } = renderHook(({ sessionId }: { sessionId: string }) => useSessionConversation(sessionId), {
      initialProps: { sessionId: SESSION_A }
    })
    await waitFor(() => expect(attachCounts.get(SESSION_A)).toBe(1))

    rerender({ sessionId: SESSION_B })
    await waitFor(() => expect(attachCounts.get(SESSION_B)).toBe(1))

    rerender({ sessionId: SESSION_A })
    rerender({ sessionId: SESSION_B })
    rerender({ sessionId: SESSION_A })

    expect(attachCounts.get(SESSION_A)).toBe(1)
    expect(attachCounts.get(SESSION_B)).toBe(1)
  })
})
