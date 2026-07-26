import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDetection, AgentId } from '../../src/shared/types'
import { AGENT_IDS } from '../../src/shared/types'

const detectMock = vi.fn()
vi.mock('../../src/main/services/detection-service', () => ({
  detectionService: { detect: (...args: unknown[]) => detectMock(...args) }
}))

const checkAuthMock = vi.fn()
vi.mock('../../src/main/services/cli-authentication-service', () => ({
  cliAuthenticationService: { checkAuthState: (...args: unknown[]) => checkAuthMock(...args) }
}))

const settingsGetMock = vi.fn()
vi.mock('../../src/main/services/settings-service', () => ({
  settingsService: { get: () => settingsGetMock() }
}))

import { cliSetupService } from '../../src/main/services/cli-setup-service'

function detection(overrides: Partial<AgentDetection> & { agentId: AgentId }): AgentDetection {
  return { installed: false, version: null, executablePath: null, error: null, structuredOutput: true, ...overrides }
}

beforeEach(() => {
  detectMock.mockReset()
  checkAuthMock.mockReset()
  settingsGetMock.mockReset()
  settingsGetMock.mockReturnValue({
    agents: Object.fromEntries(AGENT_IDS.map((id) => [id, { customPath: null }]))
  })
})

describe('cliSetupService — status classification', () => {
  it('every agent installed and launchable → "ready" for all three', async () => {
    detectMock.mockImplementation(async (agentId: AgentId) => detection({ agentId, installed: true, version: '1.0.0', executablePath: `/bin/${agentId}` }))
    checkAuthMock.mockResolvedValue('unknown')

    const statuses = await cliSetupService.getAllStatuses()

    expect(statuses).toHaveLength(3)
    expect(statuses.every((s) => s.status === 'ready')).toBe(true)
  })

  it('one CLI missing → that agent reports "not-installed", the others stay "ready"', async () => {
    detectMock.mockImplementation(async (agentId: AgentId) =>
      agentId === 'codex'
        ? detection({ agentId, installed: false, error: '"codex" not found or not runnable on PATH (searched 12 directories).' })
        : detection({ agentId, installed: true, version: '1.0.0', executablePath: `/bin/${agentId}` })
    )
    checkAuthMock.mockResolvedValue('unknown')

    const statuses = await cliSetupService.getAllStatuses()

    expect(statuses.find((s) => s.agentId === 'codex')?.status).toBe('not-installed')
    expect(statuses.filter((s) => s.status === 'ready')).toHaveLength(2)
  })

  it('every CLI missing → "not-installed" for all three, and auth is never checked for an uninstalled agent', async () => {
    detectMock.mockImplementation(async (agentId: AgentId) => detection({ agentId, installed: false, error: 'not found on PATH' }))

    const statuses = await cliSetupService.getAllStatuses()

    expect(statuses.every((s) => s.status === 'not-installed')).toBe(true)
    expect(checkAuthMock).not.toHaveBeenCalled()
  })

  it('classifies a rejected Windows .cmd/.bat shim as "incompatible", distinct from "not-installed"', async () => {
    detectMock.mockResolvedValue(
      detection({
        agentId: 'codex',
        installed: false,
        error: '"codex.cmd" is a .cmd script, not a native Windows executable. Codex requires a real codex.exe.'
      })
    )

    const status = await cliSetupService.getStatus('codex')

    expect(status.status).toBe('incompatible')
  })

  it('classifies a candidate that exists on disk but fails to launch as "incompatible"', async () => {
    detectMock.mockResolvedValue(
      detection({ agentId: 'claude-code', installed: false, error: 'Found but failed to run (1):\n  - /usr/bin/claude: existed but failed to run: exit 1' })
    )

    const status = await cliSetupService.getStatus('claude-code')

    expect(status.status).toBe('incompatible')
  })

  it('classifies a timed-out detection probe as "could-not-verify", distinct from a confident "not-installed"', async () => {
    detectMock.mockResolvedValue(detection({ agentId: 'antigravity', installed: false, error: 'timed out after 5000ms' }))

    const status = await cliSetupService.getStatus('antigravity')

    expect(status.status).toBe('could-not-verify')
  })

  it('an installed agent whose CLI requires sign-in reports "needs-login"', async () => {
    detectMock.mockResolvedValue(detection({ agentId: 'codex', installed: true, version: '1.0.0', executablePath: '/bin/codex' }))
    checkAuthMock.mockResolvedValue('required')

    const status = await cliSetupService.getStatus('codex')

    expect(status.status).toBe('needs-login')
    expect(status.authState).toBe('required')
  })

  it('an installed, authenticated agent reports "ready"', async () => {
    detectMock.mockResolvedValue(detection({ agentId: 'codex', installed: true, version: '1.0.0', executablePath: '/bin/codex' }))
    checkAuthMock.mockResolvedValue('authenticated')

    const status = await cliSetupService.getStatus('codex')

    expect(status.status).toBe('ready')
  })

  it('reads the configured custom path from settings and passes it through to detection', async () => {
    settingsGetMock.mockReturnValue({
      agents: { 'claude-code': { customPath: '/opt/claude/claude' }, codex: { customPath: null }, antigravity: { customPath: null } }
    })
    detectMock.mockResolvedValue(detection({ agentId: 'claude-code', installed: true, executablePath: '/opt/claude/claude' }))
    checkAuthMock.mockResolvedValue('unknown')

    await cliSetupService.getStatus('claude-code')

    expect(detectMock).toHaveBeenCalledWith('claude-code', '/opt/claude/claude')
  })

  it('a custom path that fails to resolve is reported as "not-installed" with the resolver\'s own explanation', async () => {
    settingsGetMock.mockReturnValue({
      agents: { 'claude-code': { customPath: '/opt/does-not-exist' }, codex: { customPath: null }, antigravity: { customPath: null } }
    })
    detectMock.mockResolvedValue(
      detection({ agentId: 'claude-code', installed: false, error: 'Could not find a working executable at the configured custom path "/opt/does-not-exist".' })
    )

    const status = await cliSetupService.getStatus('claude-code')

    expect(status.status).toBe('not-installed')
    expect(status.detection.error).toMatch(/configured custom path/)
  })
})
