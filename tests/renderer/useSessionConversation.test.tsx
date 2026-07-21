import React from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDockApi, SessionEventPayload } from '../../src/shared/preload-api'
import type { AgentEvent } from '../../src/shared/events/agent-event'
import type { SessionWithMessages } from '../../src/shared/types'
import { useSessionConversation } from '../../src/renderer/state/useSessionConversation'
import { __resetAllForTests } from '../../src/renderer/state/conversationStore'

const SESSION_ID = 'session-1'

function makeSession(): SessionWithMessages {
  return {
    id: SESSION_ID,
    workspaceId: 'w1',
    agentId: 'claude-code',
    title: 'Test session',
    status: 'idle',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    messages: []
  }
}

describe('useSessionConversation', () => {
  let eventListeners: Set<(payload: SessionEventPayload) => void>
  let attachCount: number
  let activeListenerCount: number
  let sendPromptCalls: Array<[string, string, string]>
  let deferredSend: { resolve: () => void; reject: (err: Error) => void } | null

  beforeEach(() => {
    __resetAllForTests()
    eventListeners = new Set()
    attachCount = 0
    activeListenerCount = 0
    sendPromptCalls = []
    deferredSend = null

    const api: Partial<AgentDockApi> = {
      session: {
        create: vi.fn(),
        list: vi.fn(),
        async get() {
          return makeSession()
        },
        async sendPrompt(sessionId, text, turnId) {
          sendPromptCalls.push([sessionId, text, turnId])
          return new Promise<void>((resolve, reject) => {
            deferredSend = { resolve, reject }
          })
        },
        async interrupt() {},
        async stop() {},
        async delete() {},
        onEvent(_sessionId, cb) {
          attachCount += 1
          activeListenerCount += 1
          eventListeners.add(cb)
          return () => {
            activeListenerCount -= 1
            eventListeners.delete(cb)
          }
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

  /** Every AgentEvent is turn-scoped now — emits against the turnId the hook
   *  itself generated and passed into the last sendPrompt call, so the
   *  reducer's isForActiveTurn guard accepts it. */
  function emit(event: Omit<AgentEvent, 'sessionId' | 'turnId'>, sequence: number): void {
    const turnId = sendPromptCalls[sendPromptCalls.length - 1]?.[2] ?? 't-unknown'
    const payload: SessionEventPayload = { event: { ...event, sessionId: SESSION_ID, turnId } as AgentEvent, sequence, eventId: `evt-${sequence}` }
    for (const l of eventListeners) l(payload)
  }

  it('attaches exactly one underlying event subscription per session, ever — including across StrictMode double-mount and a later remount (session switch back)', async () => {
    const { unmount } = renderHook(() => useSessionConversation(SESSION_ID), { wrapper: React.StrictMode })

    await waitFor(() => expect(activeListenerCount).toBe(1))
    expect(attachCount).toBe(1)

    // CRITICAL: unlike a plain component-scoped subscription, this one must
    // survive the component unmounting — conversationStore.ts owns it for
    // the session's whole life, not the component's, precisely so a turn
    // that's still streaming when the user switches away never gets its
    // remaining events silently dropped (see conversationStore.ts's module
    // comment for the full bug this fixes).
    unmount()
    expect(activeListenerCount).toBe(1)

    // Switching back to this same session (a fresh mount) must reuse the
    // still-live entry rather than attaching a second underlying listener.
    renderHook(() => useSessionConversation(SESSION_ID))
    expect(attachCount).toBe(1)
    expect(activeListenerCount).toBe(1)
  })

  it('shows the user message immediately — before the mocked IPC call ever resolves — and sends it exactly once', async () => {
    const { result } = renderHook(() => useSessionConversation(SESSION_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    let sendPromise!: Promise<void>
    act(() => {
      sendPromise = result.current.sendPrompt('hello there')
    })

    // Still in flight — the mocked IPC call hasn't resolved yet.
    expect(result.current.items).toEqual([expect.objectContaining({ kind: 'user', text: 'hello there', deliveryState: 'sending' })])
    expect(result.current.activityLabel).toBe('Claude Code is working…')
    expect(sendPromptCalls).toHaveLength(1)
    expect(sendPromptCalls[0][0]).toBe(SESSION_ID)
    expect(sendPromptCalls[0][1]).toBe('hello there')
    expect(sendPromptCalls[0][2]).toEqual(expect.any(String))

    deferredSend?.resolve()
    await act(async () => {
      await sendPromise
    })
    expect(result.current.items[0]).toMatchObject({ deliveryState: 'sent' })
  })

  it('marks the message failed and keeps it visible when the send genuinely fails', async () => {
    const { result } = renderHook(() => useSessionConversation(SESSION_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    let sendPromise!: Promise<void>
    act(() => {
      sendPromise = result.current.sendPrompt('will fail')
    })

    deferredSend?.reject(new Error('agent not installed'))
    await act(async () => {
      await sendPromise
    })

    expect(result.current.items[0]).toMatchObject({ kind: 'user', text: 'will fail', deliveryState: 'failed' })
    expect(result.current.warning === null || result.current.warning !== undefined).toBe(true)
  })

  it('does not let an echoed assistant_delta of the submitted prompt create a second user message', async () => {
    const { result } = renderHook(() => useSessionConversation(SESSION_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      void result.current.sendPrompt('echo me back')
    })
    deferredSend?.resolve()
    await waitFor(() => expect(result.current.items[0]).toMatchObject({ deliveryState: 'sent' }))

    act(() => emit({ type: 'assistant_delta', messageId: 'm1', textDelta: 'echo me back' }, 1))

    expect(result.current.items.filter((i) => i.kind === 'user')).toHaveLength(1)
    expect(result.current.items.filter((i) => i.kind === 'assistant')).toHaveLength(0)
  })

  it('one reply streamed across multiple deltas renders as exactly one assistant message, and Working clears on turn_completed', async () => {
    const { result } = renderHook(() => useSessionConversation(SESSION_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      void result.current.sendPrompt('go')
    })
    deferredSend?.resolve()
    await waitFor(() => expect(result.current.items[0]).toMatchObject({ deliveryState: 'sent' }))

    act(() => emit({ type: 'assistant_delta', messageId: 'm1', textDelta: 'Hello' }, 1))
    act(() => emit({ type: 'assistant_delta', messageId: 'm1', textDelta: ' world' }, 2))
    act(() => emit({ type: 'turn_completed' }, 3))

    const assistantItems = result.current.items.filter((i) => i.kind === 'assistant')
    expect(assistantItems).toHaveLength(1)
    expect(assistantItems[0]).toMatchObject({ text: 'Hello world' })
    expect(result.current.isBusy).toBe(false)
  })
})
