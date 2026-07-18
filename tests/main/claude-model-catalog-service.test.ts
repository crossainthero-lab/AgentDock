import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Minimal stand-in for the SDK's Query — only supportedModels()/
 *  interrupt() are exercised by the catalog service (it never iterates
 *  the message stream or pushes any input). */
class MockQuery {
  constructor(private readonly models: unknown[]) {}
  readonly interrupt = vi.fn(async () => {})
  supportedModels(): Promise<unknown[]> {
    return Promise.resolve(this.models)
  }
}

const queryState = vi.hoisted(() => ({ nextModels: [] as unknown[], calls: [] as Array<{ options: Record<string, unknown> }> }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((params: { options: Record<string, unknown> }) => {
    queryState.calls.push({ options: params.options })
    return new MockQuery(queryState.nextModels)
  })
}))

const repoState = vi.hoisted(() => ({ cached: null as { models: unknown[]; fetchedAt: string } | null }))
vi.mock('../../src/main/db/repositories/claude-model-catalog-repo', () => ({
  claudeModelCatalogRepo: {
    get: vi.fn(() => repoState.cached),
    set: vi.fn((catalog: { models: unknown[]; fetchedAt: string }) => {
      repoState.cached = catalog
    })
  }
}))

import { claudeModelCatalogService } from '../../src/main/services/claude-model-catalog-service'
import { claudeModelCatalogRepo } from '../../src/main/db/repositories/claude-model-catalog-repo'
import { getCapabilities } from '../../src/main/agents/capability-registry'

/** Real shape confirmed live via Query.supportedModels() against the
 *  installed Claude CLI. */
const REAL_MODELS = [
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
  },
  {
    value: 'claude-fable-5[1m]',
    resolvedModel: 'claude-fable-5',
    displayName: 'Fable',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
  },
  {
    value: 'opus',
    resolvedModel: 'claude-opus-4-8',
    displayName: 'Opus',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
  },
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku'
    // no supportsEffort/supportedEffortLevels at all — confirmed live
  }
]

describe('claudeModelCatalogService.fetchLive', () => {
  beforeEach(() => {
    queryState.nextModels = REAL_MODELS
    queryState.calls.length = 0
    repoState.cached = null
  })

  it('enriches the existing static claudeCapabilities.models list with real reasoning-effort data, fuzzy-matching ids against the SDK\'s differently-shaped real model values', async () => {
    const enriched = await claudeModelCatalogService.fetchLive('claude', '/tmp/project')
    const staticIds = getCapabilities('claude-code').models.map((m) => m.id)
    expect(enriched.map((m) => m.id)).toEqual(staticIds) // never adds/removes entries, only enriches

    const sonnet = enriched.find((m) => m.id === 'sonnet')
    expect(sonnet?.supportedReasoningEfforts?.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(sonnet?.defaultReasoningEffort).toBe('high')

    // "fable" (static id) must match against the real "claude-fable-5[1m]"
    // / resolvedModel "claude-fable-5" entry, not go unmatched.
    const fable = enriched.find((m) => m.id === 'fable')
    expect(fable?.supportedReasoningEfforts?.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('never fabricates reasoning options for a model that genuinely has none (Haiku)', async () => {
    const enriched = await claudeModelCatalogService.fetchLive('claude', '/tmp/project')
    const haiku = enriched.find((m) => m.id === 'haiku')
    expect(haiku?.supportedReasoningEfforts).toBeUndefined()
    expect(haiku?.defaultReasoningEffort).toBeUndefined()
  })

  it('never sends a real prompt — the input iterable is never pushed to, and only options (cwd/executablePath) are passed to query()', async () => {
    await claudeModelCatalogService.fetchLive('C:\\claude\\claude.exe', '/tmp/project')
    expect(queryState.calls).toHaveLength(1)
    expect(queryState.calls[0].options).toMatchObject({ cwd: '/tmp/project', pathToClaudeCodeExecutable: 'C:\\claude\\claude.exe' })
  })
})

describe('claudeModelCatalogService.refresh / getCached (fallback chain)', () => {
  beforeEach(() => {
    queryState.nextModels = REAL_MODELS
    queryState.calls.length = 0
    repoState.cached = null
    vi.mocked(claudeModelCatalogRepo.set).mockClear()
  })

  it('on a successful live fetch, caches the enriched result', async () => {
    const models = await claudeModelCatalogService.refresh('claude', '/tmp/project')
    expect(models.find((m) => m.id === 'sonnet')?.supportedReasoningEfforts).toBeDefined()
    expect(claudeModelCatalogRepo.set).toHaveBeenCalledWith(expect.objectContaining({ models }))
  })

  it('on a failed live fetch, falls back to the cache rather than an empty/unenriched list', async () => {
    repoState.cached = { models: [{ id: 'sonnet', label: 'Sonnet', supportedReasoningEfforts: [{ id: 'high', label: 'High' }] }], fetchedAt: '2026-01-01T00:00:00.000Z' }
    vi.mocked((await import('@anthropic-ai/claude-agent-sdk')).query).mockImplementationOnce(() => {
      throw new Error('spawn ENOENT')
    })

    const models = await claudeModelCatalogService.refresh('claude', '/tmp/project')
    expect(models).toEqual(repoState.cached.models)
  })

  it('with no cache and a failed fetch, falls back to the plain static list (still usable for model selection, just unenriched)', async () => {
    vi.mocked((await import('@anthropic-ai/claude-agent-sdk')).query).mockImplementationOnce(() => {
      throw new Error('offline')
    })

    const models = await claudeModelCatalogService.refresh('claude', '/tmp/project')
    expect(models).toEqual(getCapabilities('claude-code').models)
  })

  it('getCached() never spawns a process', () => {
    repoState.cached = { models: [{ id: 'sonnet', label: 'Sonnet' }], fetchedAt: '2026-01-01T00:00:00.000Z' }
    const models = claudeModelCatalogService.getCached()
    expect(models).toEqual(repoState.cached.models)
    expect(queryState.calls).toHaveLength(0)
  })
})
