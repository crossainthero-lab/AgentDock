import spawn from 'cross-spawn'
import type { AgentId, ProviderId, ProviderUsageAmount, ProviderUsageSnapshot, ProviderUsageStatus } from '@shared/types'
import { detectionService } from './detection-service'
import { validateSpawnPlan } from './spawn-guard'

const PROBE_TIMEOUT_MS = 10_000
const CACHE_MAX_AGE_MS = 60_000

interface ProbeResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
}

interface UsageInput {
  agent: AgentId
  status: ProviderUsageStatus
  quality: ProviderUsageSnapshot['quality']
  message: string
  sourceKind: ProviderUsageSnapshot['source']['kind']
  command?: string | null
  sourceError?: string | null
  usedPercent?: number | null
  remainingPercent?: number | null
  usedAmount?: ProviderUsageAmount | null
  totalAllowance?: ProviderUsageAmount | null
  resetAt?: string | null
  window?: string | null
  limitReached?: boolean
  stale?: boolean
}

const cache = new Map<AgentId, ProviderUsageSnapshot>()
const capacitySignals = new Map<AgentId, ProviderUsageSnapshot>()

function providerForAgent(agent: AgentId): ProviderId {
  switch (agent) {
    case 'claude-code':
      return 'anthropic'
    case 'codex':
      return 'openai'
    case 'antigravity':
      return 'google'
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function clampPercent(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10))
}

export function makeProviderUsageSnapshot(input: UsageInput): ProviderUsageSnapshot {
  const fetchedAt = nowIso()
  return {
    agent: input.agent,
    provider: providerForAgent(input.agent),
    status: input.status,
    quality: input.quality,
    usedPercent: clampPercent(input.usedPercent),
    remainingPercent: clampPercent(input.remainingPercent),
    usedAmount: input.usedAmount ?? null,
    totalAllowance: input.totalAllowance ?? null,
    resetAt: input.resetAt ?? null,
    window: input.window ?? null,
    limitReached: input.limitReached ?? input.status === 'limit_reached',
    message: input.message,
    source: {
      kind: input.sourceKind,
      quality: input.quality,
      command: input.command ?? null,
      fetchedAt,
      stale: input.stale ?? input.status === 'stale',
      error: input.sourceError ?? null
    },
    fetchedAt
  }
}

function withStatus(snapshot: ProviderUsageSnapshot, status: ProviderUsageStatus): ProviderUsageSnapshot {
  return {
    ...snapshot,
    status,
    quality: status === 'stale' ? 'stale' : snapshot.quality,
    source: {
      ...snapshot.source,
      kind: status === 'stale' ? 'cache' : snapshot.source.kind,
      quality: status === 'stale' ? 'stale' : snapshot.source.quality,
      stale: status === 'stale'
    }
  }
}

function runProbe(executablePath: string, args: string[]): Promise<ProbeResult> {
  validateSpawnPlan({ command: executablePath, args })
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const proc = spawn(executablePath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const timer = setTimeout(() => {
      proc.kill()
      resolve({ ok: false, stdout, stderr, error: `No response within ${PROBE_TIMEOUT_MS}ms.` })
    }, PROBE_TIMEOUT_MS)
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr, error: err.message })
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout, stderr, error: code === 0 ? undefined : `exited with code ${code ?? 'unknown'}` })
    })
  })
}

function unavailable(agent: AgentId, message: string, sourceError?: string | null): ProviderUsageSnapshot {
  return makeProviderUsageSnapshot({
    agent,
    status: sourceError ? 'error' : 'unavailable',
    quality: sourceError ? 'error' : 'unavailable',
    sourceKind: sourceError ? 'cli' : 'none',
    sourceError: sourceError ?? null,
    message
  })
}

async function probeClaude(executablePath: string): Promise<ProviderUsageSnapshot> {
  const command = 'claude auth status'
  const result = await runProbe(executablePath, ['auth', 'status'])
  if (!result.ok) {
    return makeProviderUsageSnapshot({
      agent: 'claude-code',
      status: 'error',
      quality: 'error',
      sourceKind: 'cli',
      command,
      sourceError: result.error ?? 'unknown error',
      message: `Could not check Claude authentication status (${result.error ?? 'unknown error'}). Claude Code does not expose remaining usage or quota.`
    })
  }
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { loggedIn?: boolean; email?: string; subscriptionType?: string }
    const who = parsed.loggedIn
      ? `Signed in as ${parsed.email ?? 'unknown account'}${parsed.subscriptionType ? ` (${parsed.subscriptionType} plan)` : ''}.`
      : 'Not signed in.'
    return makeProviderUsageSnapshot({
      agent: 'claude-code',
      status: 'available',
      quality: 'auth-status',
      sourceKind: 'cli',
      command,
      message: `Exact usage unavailable. Claude Code reports authentication status only. ${who}`
    })
  } catch {
    return makeProviderUsageSnapshot({
      agent: 'claude-code',
      status: 'partial',
      quality: 'partial',
      sourceKind: 'cli',
      command,
      message: 'Exact usage unavailable. Claude authentication status was returned but could not be parsed.'
    })
  }
}

async function probeCodex(executablePath: string): Promise<ProviderUsageSnapshot> {
  const command = 'codex login status'
  const result = await runProbe(executablePath, ['login', 'status'])
  if (!result.ok) {
    return makeProviderUsageSnapshot({
      agent: 'codex',
      status: 'error',
      quality: 'error',
      sourceKind: 'cli',
      command,
      sourceError: result.error ?? 'unknown error',
      message: `Could not check Codex login status (${result.error ?? 'unknown error'}). Codex does not expose remaining usage or quota.`
    })
  }
  const loginStatus = result.stdout.trim() || 'Login status unknown.'
  return makeProviderUsageSnapshot({
    agent: 'codex',
    status: 'available',
    quality: 'auth-status',
    sourceKind: 'cli',
    command,
    message: `Exact usage unavailable. Codex reports login status only. ${loginStatus}`
  })
}

function probeAntigravity(): ProviderUsageSnapshot {
  return makeProviderUsageSnapshot({
    agent: 'antigravity',
    status: 'unsupported',
    quality: 'unsupported',
    sourceKind: 'none',
    message: "Exact usage unavailable. Antigravity's CLI has no account or usage command."
  })
}

function parseTiming(message: string): { resetAt: string | null } {
  const relative = message.match(/(?:try again|retry|resets?)\s*(?:in|after)\s*(\d+)\s*(second|sec|minute|min|hour|hr)s?\b/i)
  if (relative) {
    const amount = Number(relative[1])
    const unit = relative[2].toLowerCase()
    const unitMs = unit.startsWith('sec') ? 1000 : unit.startsWith('min') ? 60_000 : 3_600_000
    return { resetAt: new Date(Date.now() + amount * unitMs).toISOString() }
  }

  const isoMatch = message.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/)
  if (isoMatch) {
    const parsed = Date.parse(isoMatch[0])
    if (!Number.isNaN(parsed)) return { resetAt: new Date(parsed).toISOString() }
  }

  return { resetAt: null }
}

function isCapacityMessage(message: string): boolean {
  return /\b(429|rate.?limit|usage limit|session limit|quota (exceeded|exhausted)|resource.?exhausted|too many requests|try again (later|in))\b/i.test(
    message
  )
}

export const providerUsageService = {
  async getUsage(agent: AgentId, customPath: string | null, force = false): Promise<ProviderUsageSnapshot> {
    const capacity = capacitySignals.get(agent)
    if (capacity && (!capacity.resetAt || Date.parse(capacity.resetAt) > Date.now())) return capacity

    const cached = cache.get(agent)
    if (!force && cached && Date.now() - Date.parse(cached.fetchedAt) < CACHE_MAX_AGE_MS) return cached

    let snapshot: ProviderUsageSnapshot
    if (agent === 'antigravity') {
      snapshot = probeAntigravity()
    } else {
      const detection = await detectionService.detect(agent, customPath)
      if (!detection.installed || !detection.executablePath) {
        snapshot = unavailable(agent, detection.error ?? `${agent} is not installed.`)
      } else {
        snapshot = agent === 'claude-code' ? await probeClaude(detection.executablePath) : await probeCodex(detection.executablePath)
      }
    }
    cache.set(agent, snapshot)
    return snapshot
  },

  recordCapacityEvent(agent: AgentId, message: string): ProviderUsageSnapshot | null {
    if (!isCapacityMessage(message)) return null
    const { resetAt } = parseTiming(message)
    const snapshot = makeProviderUsageSnapshot({
      agent,
      status: 'limit_reached',
      quality: 'capacity-signal',
      sourceKind: 'provider-event',
      message: resetAt ? `Limit reached. Reset reported at ${new Date(resetAt).toLocaleString()}.` : `Limit reached. ${message.trim()}`,
      resetAt,
      limitReached: true
    })
    capacitySignals.set(agent, snapshot)
    cache.set(agent, snapshot)
    return snapshot
  },

  markStale(agent: AgentId): ProviderUsageSnapshot | null {
    const current = cache.get(agent)
    if (!current) return null
    const stale = withStatus(current, 'stale')
    cache.set(agent, stale)
    return stale
  },

  clearForTests(): void {
    cache.clear()
    capacitySignals.clear()
  }
}
