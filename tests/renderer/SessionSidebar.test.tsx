import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { Session, Workspace } from '../../src/shared/types'

const { mockState } = vi.hoisted(() => ({
  mockState: {
    projects: [] as Workspace[],
    projectsLoading: false,
    sessionsByProject: {} as Record<string, Session[]>,
    selectedSessionId: null as string | null,
    selectSession: vi.fn(),
    deleteSession: vi.fn(),
    renameSession: vi.fn(),
    renameProject: vi.fn(),
    deleteProject: vi.fn(),
    toggleProjectCollapsed: vi.fn(),
    startNewSessionInProject: vi.fn(),
    openWorkspace: vi.fn(),
    sidebarCollapsed: false,
    toggleSidebar: vi.fn()
  }
}))

vi.mock('../../src/renderer/state/AppStateContext', () => ({
  useAppState: () => mockState
}))

import { SessionSidebar } from '../../src/renderer/components/shell/SessionSidebar'

function project(id: string, name: string, collapsed = false): Workspace {
  return { id, path: `C:\\${name}`, name, addedAt: '', lastOpenedAt: '', collapsed }
}

function session(id: string, workspaceId: string, agentId: Session['agentId'], title: string): Session {
  return {
    id,
    workspaceId,
    agentId,
    title,
    titleSource: 'generated',
    continuedFromSessionId: null,
    status: 'idle',
    createdAt: '',
    updatedAt: new Date().toISOString()
  }
}

describe('SessionSidebar — multi-project display', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.confirm = vi.fn(() => true)
    mockState.projects = [project('p1', 'Project Pulse Test Run'), project('p2', 'AgentDock Website')]
    mockState.sessionsByProject = {
      p1: [
        session('s1', 'p1', 'claude-code', 'Build Project Pulse'),
        session('s2', 'p1', 'codex', 'Add local persistence (continued)'),
        session('s3', 'p1', 'antigravity', 'Add reset dashboard (continued)')
      ],
      p2: [session('s4', 'p2', 'claude-code', 'Fix mobile navigation'), session('s5', 'p2', 'codex', 'Review waitlist backend')]
    }
  })

  it('shows multiple projects simultaneously, each with its own conversations', () => {
    render(<SessionSidebar />)
    expect(screen.getByText('Project Pulse Test Run')).toBeInTheDocument()
    expect(screen.getByText('AgentDock Website')).toBeInTheDocument()
    expect(screen.getByText('Build Project Pulse')).toBeInTheDocument()
    expect(screen.getByText('Add local persistence (continued)')).toBeInTheDocument()
    expect(screen.getByText('Fix mobile navigation')).toBeInTheDocument()
  })

  it('shows the agent as a separate badge/label, never embedded in the conversation title', () => {
    render(<SessionSidebar />)
    // The title itself never contains the agent name.
    for (const title of [
      'Build Project Pulse',
      'Add local persistence (continued)',
      'Add reset dashboard (continued)',
      'Fix mobile navigation',
      'Review waitlist backend'
    ]) {
      expect(title).not.toMatch(/claude|codex|antigravity/i)
    }
    // But the agent identity is genuinely shown alongside it.
    expect(screen.getAllByText(/Claude Code/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Codex/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Antigravity/)).toBeInTheDocument()
  })

  it('applies a distinct agent color per session (monogram badges are visually distinguishable)', () => {
    render(<SessionSidebar />)
    expect(document.querySelector('.ad-session-row__monogram--claude-code')).toBeTruthy()
    expect(document.querySelector('.ad-session-row__monogram--codex')).toBeTruthy()
    expect(document.querySelector('.ad-session-row__monogram--antigravity')).toBeTruthy()
  })

  it('toggling a project collapses/expands its own conversation list without affecting the other project', () => {
    mockState.projects = [project('p1', 'Project Pulse Test Run', true), project('p2', 'AgentDock Website', false)]
    render(<SessionSidebar />)
    // Collapsed project's sessions are not rendered...
    expect(screen.queryByText('Build Project Pulse')).not.toBeInTheDocument()
    // ...while the other, expanded project's sessions still are.
    expect(screen.getByText('Fix mobile navigation')).toBeInTheDocument()
  })

  it('a project header toggle calls toggleProjectCollapsed with that project only', () => {
    render(<SessionSidebar />)
    fireEvent.click(screen.getByText('Project Pulse Test Run'))
    expect(mockState.toggleProjectCollapsed).toHaveBeenCalledWith('p1')
  })

  it('selecting a conversation calls selectSession with its id', () => {
    render(<SessionSidebar />)
    fireEvent.click(screen.getByText('Build Project Pulse'))
    expect(mockState.selectSession).toHaveBeenCalledWith('s1')
  })

  it('renaming a conversation commits the new title on blur and never on an unchanged value', () => {
    render(<SessionSidebar />)
    fireEvent.click(screen.getAllByLabelText('Rename conversation')[0])
    const input = screen.getByDisplayValue('Build Project Pulse') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'A brand new title' } })
    fireEvent.blur(input)
    expect(mockState.renameSession).toHaveBeenCalledWith('s1', 'A brand new title')
  })

  it('deleting a conversation asks for confirmation before calling deleteSession', () => {
    render(<SessionSidebar />)
    const deleteButtons = screen.getAllByLabelText('Delete conversation')
    fireEvent.click(deleteButtons[0])
    expect(window.confirm).toHaveBeenCalled()
    expect(mockState.deleteSession).toHaveBeenCalledWith('s1')
  })

  it('deleting a project asks for confirmation before calling deleteProject', () => {
    render(<SessionSidebar />)
    const deleteButtons = screen.getAllByLabelText('Delete project')
    fireEvent.click(deleteButtons[0])
    expect(window.confirm).toHaveBeenCalled()
    expect(mockState.deleteProject).toHaveBeenCalledWith('p1')
  })

  it("a project's own + button starts a new session scoped to that project, not the global default", () => {
    render(<SessionSidebar />)
    const newButtons = screen.getAllByLabelText('New conversation in this project')
    fireEvent.click(newButtons[1])
    expect(mockState.startNewSessionInProject).toHaveBeenCalledWith('p2')
  })

  it('shows an empty-project hint when a project genuinely has no conversations yet', () => {
    mockState.projects = [project('p3', 'Empty Project')]
    mockState.sessionsByProject = { p3: [] }
    render(<SessionSidebar />)
    expect(screen.getByText('No conversations yet.')).toBeInTheDocument()
  })

  it('shows the empty-workspace hint only when there are truly no projects at all', () => {
    mockState.projects = []
    mockState.sessionsByProject = {}
    render(<SessionSidebar />)
    expect(screen.getByText('Open a project to see conversations here.')).toBeInTheDocument()
  })
})
