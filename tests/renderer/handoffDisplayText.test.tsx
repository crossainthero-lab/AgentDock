// Regression coverage for the "handoff context is visible in the user
// bubble" bug: a continuation's full delivered prompt (the user's own
// instruction followed by the entire "--- Continuation context ---"
// envelope — workspace path, prior actions, files changed, unresolved
// issues; see handoff-service.ts's buildContinuationPrompt) used to be the
// ONLY text ever recorded for the user's chat bubble, because
// conversationStore.sendPrompt had no way to distinguish "what the user
// typed" from "what's actually delivered to the agent".
//
// Fixed by threading an optional `displayText` alongside `text` end to end
// (HandoffDialog -> conversationStore.sendPrompt -> session.sendPrompt IPC
// -> session-service.sendPrompt -> messageRepo -> AgentEventReducer's
// sessionMessageToChatItem -> ConversationView's MessageBubble): `text`
// keeps reaching the agent completely unchanged; `displayText`, when
// present, is what the bubble shows and what gets persisted for it — see
// each of those files' own doc comments for the specific fix.
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDockApi, SessionEventPayload } from '../../src/shared/preload-api'
import type { SessionMessage, SessionWithMessages } from '../../src/shared/types'
import { useSessionConversation } from '../../src/renderer/state/useSessionConversation'
import { __resetAllForTests, sendPrompt as storeSendPrompt } from '../../src/renderer/state/conversationStore'

const SESSION_ID = 'antigravity-continued-session'

const FULL_PROMPT =
  'Add a daily focus timer with Start, Pause, and Reset.\n\n' +
  '--- Continuation context ---\n' +
  'Workspace: C:\\Users\\billy\\Documents\\Testing Zone\\Testing Run 5\n' +
  'Continuing from a Codex conversation ("FocusBoard").\n\n' +
  'Prior work completed:\n' +
  '- Ran PowerShell checks\n' +
  '- Result: Implemented the requested changes.\n\n' +
  'Files changed: index.html, script.js, style.css'

const DISPLAY_TEXT = 'Add a daily focus timer with Start, Pause, and Reset.'

function makeSession(id: string, messages: SessionMessage[] = []): SessionWithMessages {
  return {
    id,
    workspaceId: 'w1',
    agentId: 'antigravity',
    title: 'FocusBoard (continued)',
    titleSource: 'handoff',
    continuedFromSessionId: 'codex-session',
    status: 'idle',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    messages
  }
}

describe('handoff display text — clean user bubble vs. full delivered prompt', () => {
  let sendPromptCalls: Array<{ sessionId: string; text: string; turnId: string; displayText?: string }>
  let persistedBySession: Map<string, SessionMessage[]>

  beforeEach(() => {
    __resetAllForTests()
    sendPromptCalls = []
    persistedBySession = new Map()

    const api: Partial<AgentDockApi> = {
      session: {
        create: vi.fn(),
        list: vi.fn(),
        get: (sessionId) => Promise.resolve(makeSession(sessionId, persistedBySession.get(sessionId) ?? [])),
        async sendPrompt(sessionId, text, turnId, _images, displayText) {
          sendPromptCalls.push({ sessionId, text, turnId, displayText })
          // Mirrors session-service.sendPrompt's real persistence — the
          // fixture for "restart"/"session switch" tests below reads this
          // back exactly the way a real app restart would re-seed from disk.
          const existing = persistedBySession.get(sessionId) ?? []
          persistedBySession.set(sessionId, [
            ...existing,
            {
              id: `msg-${existing.length}`,
              sessionId,
              role: 'user',
              content: { kind: 'text', text, displayText },
              createdAt: new Date().toISOString()
            }
          ])
        },
        async interrupt() {},
        async stop() {},
        async delete() {},
        onEvent() {
          return () => {}
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

  it('the user-written task appears exactly once in the user bubble, and the continuation context is not visible in it', async () => {
    void storeSendPrompt(SESSION_ID, 'antigravity', FULL_PROMPT, undefined, DISPLAY_TEXT)

    const { result } = renderHook(() => useSessionConversation(SESSION_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const userItems = result.current.items.filter((i) => i.kind === 'user')
    expect(userItems).toHaveLength(1)
    const user = userItems[0] as Extract<(typeof userItems)[number], { kind: 'user' }>

    // What a renderer actually shows (ConversationView: displayText ?? text).
    const rendered = user.displayText ?? user.text
    expect(rendered).toBe(DISPLAY_TEXT)
    expect((rendered.match(new RegExp(DISPLAY_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length).toBe(1)
    expect(rendered).not.toContain('--- Continuation context ---')
    expect(rendered).not.toContain('Workspace:')
    expect(rendered).not.toContain('Prior work completed')
  })

  it('the internal prompt actually sent to the receiving agent still contains the full continuation context', async () => {
    void storeSendPrompt(SESSION_ID, 'antigravity', FULL_PROMPT, undefined, DISPLAY_TEXT)
    await waitFor(() => expect(sendPromptCalls).toHaveLength(1))

    const delivered = sendPromptCalls[0].text
    expect(delivered).toContain('--- Continuation context ---')
    expect(delivered).toContain('Workspace: C:\\Users\\billy\\Documents\\Testing Zone\\Testing Run 5')
    expect(delivered).toContain('Files changed:')
    expect(delivered).toContain(DISPLAY_TEXT)
  })

  it('text and displayText cannot overwrite each other — both remain distinct on the same item', async () => {
    void storeSendPrompt(SESSION_ID, 'antigravity', FULL_PROMPT, undefined, DISPLAY_TEXT)
    const { result } = renderHook(() => useSessionConversation(SESSION_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const user = result.current.items.find((i) => i.kind === 'user') as { text: string; displayText?: string }
    expect(user.text).toBe(FULL_PROMPT)
    expect(user.displayText).toBe(DISPLAY_TEXT)
    expect(user.text).not.toBe(user.displayText)
  })

  it('restarting AgentDock (a fresh store re-seeding entirely from persisted history) preserves the clean user-visible task', async () => {
    void storeSendPrompt(SESSION_ID, 'antigravity', FULL_PROMPT, undefined, DISPLAY_TEXT)
    await waitFor(() => expect(sendPromptCalls).toHaveLength(1))

    // Simulates an app restart: the in-memory store is gone, and the ONLY
    // thing the next session.get() has to reconstruct the bubble from is
    // whatever session-service actually persisted (captured by the
    // sendPrompt mock above into persistedBySession).
    __resetAllForTests()

    const { result } = renderHook(() => useSessionConversation(SESSION_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const user = result.current.items.find((i) => i.kind === 'user') as { text: string; displayText?: string }
    expect(user.displayText).toBe(DISPLAY_TEXT)
    expect(user.displayText).not.toContain('--- Continuation context ---')
    expect(user.text).toBe(FULL_PROMPT)
  })

  it('switching between sessions does not expose the internal prompt of the OTHER session', async () => {
    const OTHER_SESSION = 'other-session'
    void storeSendPrompt(SESSION_ID, 'antigravity', FULL_PROMPT, undefined, DISPLAY_TEXT)
    void storeSendPrompt(OTHER_SESSION, 'codex', 'plain message', undefined, undefined)

    const first = renderHook(() => useSessionConversation(SESSION_ID))
    await waitFor(() => expect(first.result.current.loading).toBe(false))
    const second = renderHook(() => useSessionConversation(OTHER_SESSION))
    await waitFor(() => expect(second.result.current.loading).toBe(false))

    const firstUser = first.result.current.items.find((i) => i.kind === 'user') as { text: string; displayText?: string }
    const secondUser = second.result.current.items.find((i) => i.kind === 'user') as { text: string; displayText?: string }

    expect(firstUser.displayText).toBe(DISPLAY_TEXT)
    expect(secondUser.displayText).toBeUndefined()
    expect(secondUser.text).toBe('plain message')
    // Neither session's bubble carries the other's content.
    expect(secondUser.text).not.toContain('--- Continuation context ---')
  })
})
