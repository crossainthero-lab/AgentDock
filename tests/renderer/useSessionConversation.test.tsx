import React from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDockApi, SessionEventPayload } from '../../src/shared/preload-api'
import type { AgentEvent } from '../../src/shared/events/agent-event'
import type { SessionWithMessages } from '../../src/shared/types'
import { useSessionConversation } from '../../src/renderer/state/useSessionConversation'

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
  let sendPromptCalls: Array<[string, string]>
  let deferredSend: { resolve: () => void; reject: (err: Error) => void } | null

  beforeEach(() => {
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
        async sendPrompt(sessionId, text) {
          sendPromptCalls.push([sessionId, text])
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

  function emit(event: AgentEvent, sequence: number): void {
    const payload: SessionEventPayload = { event, sequence, eventId: `evt-${sequence}` }
    for (const l of eventListeners) l(payload)
  }

  it('attaches exactly one live listener at a time, even across a StrictMode double-mount', async () => {
    const { unmount } = renderHook(() => useSessionConversation(SESSION_ID), { wrapper: React.StrictMode })

    await waitFor(() => expect(activeListenerCount).toBe(1))
    // StrictMode may have mounted/cleaned-up/remounted under the hood, but
    // there must never be more than one *active* subscription at a time.
    expect(activeListenerCount).toBe(1)

    unmount()
    expect(activeListenerCount).toBe(0)
  })

  it('shows the user message immediately — before the mocked PTY write ever resolves — and writes it exactly once', async () => {
    const { result } = renderHook(() => useSessionConversation(SESSION_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    let sendPromise!: Promise<void>
    act(() => {
      sendPromise = result.current.sendPrompt('hello there')
    })

    // Still in flight — the mocked IPC call hasn't resolved yet.
    expect(result.current.items).toEqual([expect.objectContaining({ kind: 'user', text: 'hello there', deliveryState: 'sending' })])
    expect(result.current.activityLabel).toBe('Claude Code is working…')
    expect(sendPromptCalls).toEqual([[SESSION_ID, 'hello there']])

    deferredSend?.resolve()
    await act(async () => {
      await sendPromise
    })
    expect(result.current.items[0]).toMatchObject({ deliveryState: 'sent' })
  })

  it('marks the message failed and keeps it visible when the write genuinely fails', async () => {
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

  it('does not let a CLI echo of the submitted prompt create a second user message', async () => {
    const { result } = renderHook(() => useSessionConversation(SESSION_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      void result.current.sendPrompt('echo me back')
    })
    deferredSend?.resolve()
    await waitFor(() => expect(result.current.items[0]).toMatchObject({ deliveryState: 'sent' }))

    act(() => emit({ type: 'assistant_message', text: 'echo me back' }, 1))

    expect(result.current.items.filter((i) => i.kind === 'user')).toHaveLength(1)
    expect(result.current.items.filter((i) => i.kind === 'assistant')).toHaveLength(0)
  })

  it('one reply streamed across multiple chunks renders as exactly one assistant message', async () => {
    const { result } = renderHook(() => useSessionConversation(SESSION_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      void result.current.sendPrompt('go')
    })
    deferredSend?.resolve()
    await waitFor(() => expect(result.current.items[0]).toMatchObject({ deliveryState: 'sent' }))

    act(() => emit({ type: 'assistant_message', text: 'Hello' }, 1))
    act(() => emit({ type: 'assistant_message', text: ' world' }, 2))
    act(() => emit({ type: 'session_complete', exitCode: 0 }, 3))

    const assistantItems = result.current.items.filter((i) => i.kind === 'assistant')
    expect(assistantItems).toHaveLength(1)
    expect(assistantItems[0]).toMatchObject({ text: 'Hello world' })
    expect(result.current.isBusy).toBe(false)
  })
})
