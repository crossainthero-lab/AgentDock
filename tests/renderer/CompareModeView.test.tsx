import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AgentCapabilities, AgentDetection, AgentId, ProviderUsageSnapshot, Session, Workspace } from '../../src/shared/types'

const { mockState, api, sendPromptMock, interruptBySession, busySessions } = vi.hoisted(() => ({
  mockState: {
    projects: [{ id: 'w1', path: 'C:\\repo', name: 'Repo', addedAt: '', lastOpenedAt: '', collapsed: false }] as Workspace[],
    agents: [] as AgentDetection[],
    settings: {
      agents: {
        'claude-code': { customPath: null, permissionMode: 'default', model: 'sonnet', reasoningEffort: null },
        codex: { customPath: null, permissionMode: 'default', model: 'gpt-5', reasoningEffort: 'medium' },
        antigravity: { customPath: null, permissionMode: 'default', model: 'Gemini 3.5 Flash (Medium)', reasoningEffort: null }
      }
    },
    refreshSessions: vi.fn(),
    providerUsages: {} as Partial<Record<AgentId, ProviderUsageSnapshot>>,
    providerUsageLoading: {} as Partial<Record<AgentId, boolean>>,
    refreshProviderUsage: vi.fn()
  },
  api: {
    session: {
      create: vi.fn()
    },
    agents: {
      getCapabilities: vi.fn()
    },
    codex: {
      getModelCatalog: vi.fn()
    },
    claude: {
      getModelCatalog: vi.fn()
    }
  },
  sendPromptMock: vi.fn(),
  interruptBySession: {} as Record<string, ReturnType<typeof vi.fn>>,
  busySessions: new Set<string>()
}))

vi.mock('../../src/renderer/state/AppStateContext', () => ({
  useAppState: () => mockState
}))

vi.mock('../../src/renderer/lib/agentDockClient', () => ({
  getAgentDock: () => api
}))

vi.mock('../../src/renderer/state/conversationStore', () => ({
  sendPrompt: (...args: unknown[]) => sendPromptMock(...args)
}))

vi.mock('../../src/renderer/state/useSessionConversation', () => ({
  useSessionConversation: (sessionId: string) => {
    interruptBySession[sessionId] ??= vi.fn()
    return {
      session: { id: sessionId, workspaceId: 'w1', agentId: sessionId.split('-')[1] as AgentId, title: sessionId, status: 'idle' },
      items: [],
      activityLabel: null,
      pendingInteraction: null,
      warning: null,
      status: busySessions.has(sessionId) ? 'running' : 'idle',
      isBusy: busySessions.has(sessionId),
      loading: false,
      traces: [],
      currentModel: null,
      currentReasoningEffort: null,
      effectivePermissionMode: null,
      sendPrompt: vi.fn(),
      sendPromptWithOptions: vi.fn(),
      retryMessage: vi.fn(),
      interrupt: interruptBySession[sessionId],
      stop: vi.fn(),
      respondToInteraction: vi.fn(),
      setModel: vi.fn(),
      runCommand: vi.fn(),
      openExternalTerminal: vi.fn()
    }
  }
}))

import { CompareModeView } from '../../src/renderer/components/compare/CompareModeView'

function detection(agentId: AgentId, installed = true): AgentDetection {
  return { agentId, installed, version: '1.0.0', executablePath: installed ? agentId : null, error: installed ? null : 'missing', structuredOutput: true }
}

function caps(agentId: AgentId, models: Array<{ id: string; label: string }>): AgentCapabilities {
  return {
    agentId,
    models,
    permissionModes: [],
    commands: [],
    supportsLiveModelSwitch: true,
    supportsLivePermissionSwitch: false,
    authState: 'unknown'
  }
}

function session(agentId: AgentId): Session {
  return {
    id: `s-${agentId}`,
    workspaceId: 'w1',
    agentId,
    title: `Compare: ${agentId}`,
    titleSource: 'manual',
    continuedFromSessionId: null,
    status: 'idle',
    createdAt: '',
    updatedAt: ''
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(interruptBySession)) delete interruptBySession[key]
  busySessions.clear()
  mockState.agents = [detection('claude-code'), detection('codex'), detection('antigravity')]
  api.session.create.mockImplementation(async (input: { agentId: AgentId }) => session(input.agentId))
  api.agents.getCapabilities.mockImplementation(async (agentId: AgentId) =>
    caps(agentId, agentId === 'antigravity' ? [{ id: 'Gemini 3.5 Flash (Medium)', label: 'Gemini 3.5 Flash (Medium)' }] : [])
  )
  api.codex.getModelCatalog.mockResolvedValue({ models: [{ id: 'gpt-5', label: 'GPT-5' }, { id: 'gpt-5.x', label: 'GPT-5.x' }] })
  api.claude.getModelCatalog.mockResolvedValue([{ id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }])
  sendPromptMock.mockResolvedValue(undefined)
})

describe('CompareModeView', () => {
  it('starts compare mode with the default two installed agents', async () => {
    render(<CompareModeView projectId="w1" />)
    fireEvent.click(screen.getByText('Start Compare'))
    await waitFor(() => expect(api.session.create).toHaveBeenCalledTimes(2))
    expect(api.session.create).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'claude-code', workspaceId: 'w1' }))
    expect(api.session.create).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'codex', workspaceId: 'w1' }))
  })

  it('can select all three agents', async () => {
    render(<CompareModeView projectId="w1" />)
    fireEvent.click(screen.getByText('Antigravity'))
    fireEvent.click(screen.getByText('Start Compare'))
    await waitFor(() => expect(api.session.create).toHaveBeenCalledTimes(3))
  })

  it('sends the same prompt exactly once to each independent session with write-safe permissions', async () => {
    render(<CompareModeView projectId="w1" />)
    fireEvent.click(screen.getByText('Start Compare'))
    await screen.findByPlaceholderText('Send the same prompt to every selected agent...')
    fireEvent.change(screen.getByPlaceholderText('Send the same prompt to every selected agent...'), { target: { value: 'Summarize this repo' } })
    fireEvent.click(screen.getByText('Send to all'))

    await waitFor(() => expect(sendPromptMock).toHaveBeenCalledTimes(2))
    expect(sendPromptMock).toHaveBeenNthCalledWith(
      1,
      's-claude-code',
      'claude-code',
      'Summarize this repo',
      undefined,
      undefined,
      expect.objectContaining({ permissionMode: 'plan', model: 'sonnet' })
    )
    expect(sendPromptMock).toHaveBeenNthCalledWith(
      2,
      's-codex',
      'codex',
      'Summarize this repo',
      undefined,
      undefined,
      expect.objectContaining({ permissionMode: 'read-only', model: 'gpt-5' })
    )
  })

  it('keeps provider failures isolated when one send rejects', async () => {
    sendPromptMock.mockImplementation((sessionId: string) => (sessionId === 's-claude-code' ? Promise.reject(new Error('limit')) : Promise.resolve()))
    render(<CompareModeView projectId="w1" />)
    fireEvent.click(screen.getByText('Start Compare'))
    await screen.findByPlaceholderText('Send the same prompt to every selected agent...')
    fireEvent.change(screen.getByPlaceholderText('Send the same prompt to every selected agent...'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByText('Send to all'))
    await waitFor(() => expect(sendPromptMock).toHaveBeenCalledTimes(2))
  })

  it('cancels one pane without cancelling the others', async () => {
    busySessions.add('s-claude-code')
    render(<CompareModeView projectId="w1" />)
    fireEvent.click(screen.getByText('Start Compare'))
    await waitFor(() => expect(screen.getAllByText('Stop').length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByText('Stop')[0])
    expect(interruptBySession['s-claude-code']).toHaveBeenCalledTimes(1)
    expect(interruptBySession['s-codex']).not.toHaveBeenCalled()
  })

  it('does not expose unavailable agents for selection', async () => {
    mockState.agents = [detection('claude-code'), detection('codex', false), detection('antigravity')]
    render(<CompareModeView projectId="w1" />)
    await waitFor(() => expect(api.agents.getCapabilities).toHaveBeenCalledTimes(3))
    const codexChoice = screen.getByText('Codex').closest('button')
    expect(codexChoice).toBeDisabled()
    expect(screen.getByText('Not detected')).toBeInTheDocument()
  })

  it('sends pane-specific model selections', async () => {
    render(<CompareModeView projectId="w1" />)
    fireEvent.click(screen.getByText('Start Compare'))
    await waitFor(() => expect(screen.getAllByRole('combobox')).toHaveLength(2))
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'opus' } })
    fireEvent.change(screen.getByPlaceholderText('Send the same prompt to every selected agent...'), { target: { value: 'model check' } })
    fireEvent.click(screen.getByText('Send to all'))
    await waitFor(() =>
      expect(sendPromptMock).toHaveBeenCalledWith(
        's-claude-code',
        'claude-code',
        'model check',
        undefined,
        undefined,
        expect.objectContaining({ model: 'opus' })
      )
    )
  })
})
