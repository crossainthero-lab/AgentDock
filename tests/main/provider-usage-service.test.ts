import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

interface MockProc extends EventEmitter {
  stdout: EventEmitter & { setEncoding: (enc: string) => void }
  stderr: EventEmitter & { setEncoding: (enc: string) => void }
  kill: ReturnType<typeof vi.fn>
}

const spawnCalls: Array<{ command: string; args: string[]; proc: MockProc }> = []

function makeMockProc(): MockProc {
  const proc = new EventEmitter() as MockProc
  const stdout = new EventEmitter() as MockProc['stdout']
  stdout.setEncoding = vi.fn()
  const stderr = new EventEmitter() as MockProc['stderr']
  stderr.setEncoding = vi.fn()
  proc.stdout = stdout
  proc.stderr = stderr
  proc.kill = vi.fn()
  return proc
}

vi.mock('cross-spawn', () => {
  const spawn = vi.fn((command: string, args: string[]) => {
    const proc = makeMockProc()
    spawnCalls.push({ command, args, proc })
    return proc
  })
  return { default: spawn }
})

const detectMock = vi.fn()
vi.mock('../../src/main/services/detection-service', () => ({
  detectionService: { detect: (...args: unknown[]) => detectMock(...args) }
}))

import { makeProviderUsageSnapshot, providerUsageService } from '../../src/main/services/provider-usage-service'

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

function finish(proc: MockProc, stdout: string, exitCode = 0): void {
  proc.stdout.emit('data', stdout)
  proc.emit('exit', exitCode)
}

beforeEach(() => {
  spawnCalls.length = 0
  detectMock.mockReset()
  providerUsageService.clearForTests()
})

describe('providerUsageService snapshots', () => {
  it('represents exact provider usage only when exact data is supplied', () => {
    const result = makeProviderUsageSnapshot({
      agent: 'codex',
      status: 'exact',
      quality: 'exact',
      sourceKind: 'cli',
      command: 'provider usage --json',
      usedPercent: 42,
      remainingPercent: 58,
      usedAmount: { value: 42, unit: 'requests' },
      totalAllowance: { value: 100, unit: 'requests' },
      resetAt: '2026-08-11T06:00:00.000Z',
      window: 'daily',
      message: 'Exact usage reported.'
    })
    expect(result.usedPercent).toBe(42)
    expect(result.remainingPercent).toBe(58)
    expect(result.quality).toBe('exact')
  })

  it('supports partial usage without inventing percentages', () => {
    const result = makeProviderUsageSnapshot({
      agent: 'claude-code',
      status: 'partial',
      quality: 'partial',
      sourceKind: 'cli',
      usedAmount: { value: 12, unit: 'USD' },
      message: 'Only spend was reported.'
    })
    expect(result.usedAmount?.value).toBe(12)
    expect(result.usedPercent).toBeNull()
    expect(result.remainingPercent).toBeNull()
  })

  it('reports unsupported providers without spawning a probe', async () => {
    const result = await providerUsageService.getUsage('antigravity', null, true)
    expect(result.status).toBe('unsupported')
    expect(result.usedPercent).toBeNull()
    expect(spawnCalls).toHaveLength(0)
    expect(detectMock).not.toHaveBeenCalled()
  })

  it('reports provider command failures without a fabricated percentage', async () => {
    detectMock.mockResolvedValue({ installed: true, executablePath: process.execPath, version: '1.0.0', error: null })
    const promise = providerUsageService.getUsage('codex', null, true)
    await flushMicrotasks()
    spawnCalls[0]!.proc.emit('error', new Error('spawn failed'))
    const result = await promise
    expect(result.status).toBe('error')
    expect(result.source.error).toContain('spawn failed')
    expect(result.usedPercent).toBeNull()
    expect(result.remainingPercent).toBeNull()
  })

  it('uses real auth status as availability, not quota precision', async () => {
    detectMock.mockResolvedValue({ installed: true, executablePath: process.execPath, version: '1.0.0', error: null })
    const promise = providerUsageService.getUsage('claude-code', null, true)
    await flushMicrotasks()
    finish(spawnCalls[0]!.proc, JSON.stringify({ loggedIn: true, email: 'user@example.com', subscriptionType: 'pro' }))
    const result = await promise
    expect(result.status).toBe('available')
    expect(result.quality).toBe('auth-status')
    expect(result.message).toContain('Exact usage unavailable')
    expect(result.usedPercent).toBeNull()
  })

  it('records rate-limit state and reset timestamps from real capacity events', () => {
    const result = providerUsageService.recordCapacityEvent('codex', 'Rate limit exceeded. Try again in 20 minutes.')
    expect(result?.status).toBe('limit_reached')
    expect(result?.limitReached).toBe(true)
    expect(result?.resetAt).not.toBeNull()
    expect(result?.usedPercent).toBeNull()
  })

  it('can mark cached data stale', () => {
    providerUsageService.recordCapacityEvent('claude-code', 'Claude AI usage limit reached.')
    const stale = providerUsageService.markStale('claude-code')
    expect(stale?.status).toBe('stale')
    expect(stale?.source.stale).toBe(true)
  })

  it('reports unavailable detection failures honestly', async () => {
    detectMock.mockResolvedValue({ installed: false, executablePath: null, version: null, error: 'Codex not found.' })
    const result = await providerUsageService.getUsage('codex', null, true)
    expect(result.status).toBe('unavailable')
    expect(result.message).toBe('Codex not found.')
    expect(result.usedPercent).toBeNull()
  })
})
