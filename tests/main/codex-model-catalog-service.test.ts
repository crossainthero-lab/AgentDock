import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

interface MockProc extends EventEmitter {
  stdout: EventEmitter & { setEncoding: (enc: string) => void }
  stdin: { write: ReturnType<typeof vi.fn> }
  kill: ReturnType<typeof vi.fn>
}

const spawnCalls: Array<{ command: string; args: string[]; proc: MockProc }> = []

function makeMockProc(): MockProc {
  const proc = new EventEmitter() as MockProc
  const stdout = new EventEmitter() as MockProc['stdout']
  stdout.setEncoding = vi.fn()
  proc.stdout = stdout
  proc.stdin = { write: vi.fn() }
  proc.kill = vi.fn()
  return proc
}

vi.mock('node:child_process', () => {
  const spawn = vi.fn((command: string, args: string[]) => {
    const proc = makeMockProc()
    spawnCalls.push({ command, args, proc })
    return proc
  })
  return { spawn, default: { spawn } }
})

const repoState = vi.hoisted(() => ({ cached: null as { models: unknown[]; fetchedAt: string } | null }))
vi.mock('../../src/main/db/repositories/codex-model-catalog-repo', () => ({
  codexModelCatalogRepo: {
    get: vi.fn(() => repoState.cached),
    set: vi.fn((catalog: { models: unknown[]; fetchedAt: string }) => {
      repoState.cached = catalog
    })
  }
}))

import { codexModelCatalogService } from '../../src/main/services/codex-model-catalog-service'
import { codexModelCatalogRepo } from '../../src/main/db/repositories/codex-model-catalog-repo'

/** Emits a JSON-RPC response line as the mock process would over stdout,
 *  matching the exact real wire format confirmed live against `codex
 *  app-server` (newline-delimited JSON, `{id, result}` on success). */
function respond(proc: MockProc, id: number, result: unknown): void {
  proc.stdout.emit('data', JSON.stringify({ id, result }) + '\n')
}

function respondError(proc: MockProc, id: number, message: string): void {
  proc.stdout.emit('data', JSON.stringify({ id, error: { code: -32000, message } }) + '\n')
}

/** Real shape confirmed live via `codex app-server`'s model/list. */
const REAL_SOL_MODEL = {
  id: 'gpt-5.6-sol',
  model: 'gpt-5.6-sol',
  displayName: 'GPT-5.6-Sol',
  description: 'Latest frontier agentic coding model.',
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: 'low',
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
    { reasoningEffort: 'ultra', description: 'Maximum reasoning with automatic task delegation' }
  ]
}

const REAL_LEGACY_MODEL = {
  id: 'gpt-5.4',
  model: 'gpt-5.4',
  displayName: 'GPT-5.4',
  description: 'Previous generation model.',
  hidden: true,
  isDefault: false,
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }]
}

describe('codexModelCatalogService.fetchLive', () => {
  beforeEach(() => {
    spawnCalls.length = 0
    repoState.cached = null
  })

  it('spawns `codex app-server`, initializes, and maps a real single-page model/list response', async () => {
    const promise = codexModelCatalogService.fetchLive('C:\\codex\\codex.exe')
    await Promise.resolve()
    await Promise.resolve()

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].command).toBe('C:\\codex\\codex.exe')
    expect(spawnCalls[0].args).toEqual(['app-server'])

    const proc = spawnCalls[0].proc
    respond(proc, 1, { userAgent: 'x', codexHome: 'x', platformFamily: 'windows', platformOs: 'windows' })
    await Promise.resolve()
    respond(proc, 2, { data: [REAL_SOL_MODEL, REAL_LEGACY_MODEL], nextCursor: null })

    const models = await promise
    expect(models).toEqual([
      {
        id: 'gpt-5.6-sol',
        label: 'GPT-5.6-Sol',
        description: 'Latest frontier agentic coding model. (default)',
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: [
          { id: 'low', label: 'Low', description: 'Fast responses with lighter reasoning' },
          { id: 'ultra', label: 'Ultra', description: 'Maximum reasoning with automatic task delegation' }
        ]
      },
      {
        id: 'gpt-5.4',
        label: 'GPT-5.4',
        description: 'Previous generation model.',
        hidden: true,
        isDefault: false,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [{ id: 'medium', label: 'Medium', description: 'Balanced' }]
      }
    ])
    expect(proc.kill).toHaveBeenCalled()
  })

  it('requests includeHidden:true so hidden/legacy models are part of the same fetch, and includes the cursor from the previous page', async () => {
    const promise = codexModelCatalogService.fetchLive('codex')
    await Promise.resolve()
    await Promise.resolve()
    const proc = spawnCalls[0].proc
    respond(proc, 1, {})
    await Promise.resolve()
    respond(proc, 2, { data: [REAL_SOL_MODEL], nextCursor: '2' })
    await Promise.resolve()
    await Promise.resolve()
    respond(proc, 3, { data: [REAL_LEGACY_MODEL], nextCursor: null })

    const models = await promise
    expect(models.map((m) => m.id)).toEqual(['gpt-5.6-sol', 'gpt-5.4'])

    const secondCall = JSON.parse(proc.stdin.write.mock.calls[1][0] as string)
    expect(secondCall).toMatchObject({ method: 'model/list', params: { includeHidden: true, cursor: null } })
    const thirdCall = JSON.parse(proc.stdin.write.mock.calls[2][0] as string)
    expect(thirdCall).toMatchObject({ method: 'model/list', params: { includeHidden: true, cursor: '2' } })
  })

  it('rejects (never returns a partial/fabricated list) when initialize itself errors', async () => {
    const promise = codexModelCatalogService.fetchLive('codex')
    await Promise.resolve()
    await Promise.resolve()
    const proc = spawnCalls[0].proc
    respondError(proc, 1, 'Not initialized')

    await expect(promise).rejects.toThrow('initialize failed: Not initialized')
  })

  it('rejects when model/list itself errors mid-pagination', async () => {
    const promise = codexModelCatalogService.fetchLive('codex')
    await Promise.resolve()
    await Promise.resolve()
    const proc = spawnCalls[0].proc
    respond(proc, 1, {})
    await Promise.resolve()
    respondError(proc, 2, 'internal error')

    await expect(promise).rejects.toThrow('model/list failed: internal error')
  })

  it('rejects if the process errors out (e.g. spawn failure) instead of hanging forever', async () => {
    const promise = codexModelCatalogService.fetchLive('codex')
    await Promise.resolve()
    const proc = spawnCalls[0].proc
    proc.emit('error', new Error('ENOENT'))

    await expect(promise).rejects.toThrow('ENOENT')
  })

  it('rejects if the process exits before responding', async () => {
    const promise = codexModelCatalogService.fetchLive('codex')
    await Promise.resolve()
    const proc = spawnCalls[0].proc
    proc.emit('exit', 1, null)

    await expect(promise).rejects.toThrow('exited before responding')
  })
})

describe('codexModelCatalogService.refresh / getCached (fallback chain)', () => {
  beforeEach(() => {
    spawnCalls.length = 0
    repoState.cached = null
    vi.mocked(codexModelCatalogRepo.set).mockClear()
  })

  it('on a successful live fetch, caches the result and reports source:"live"', async () => {
    const promise = codexModelCatalogService.refresh('codex', null)
    await Promise.resolve()
    await Promise.resolve()
    const proc = spawnCalls[0].proc
    respond(proc, 1, {})
    await Promise.resolve()
    respond(proc, 2, { data: [REAL_SOL_MODEL], nextCursor: null })

    const result = await promise
    expect(result.source).toBe('live')
    expect(result.models.map((m) => m.id)).toEqual(['gpt-5.6-sol'])
    expect(codexModelCatalogRepo.set).toHaveBeenCalledWith(expect.objectContaining({ models: result.models }))
  })

  it('on a failed live fetch, falls back to the cached catalogue rather than returning empty', async () => {
    repoState.cached = { models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }], fetchedAt: '2026-01-01T00:00:00.000Z' }

    const promise = codexModelCatalogService.refresh('codex', null)
    await Promise.resolve()
    const proc = spawnCalls[0].proc
    proc.emit('error', new Error('spawn ENOENT'))

    const result = await promise
    expect(result.source).toBe('cache')
    expect(result.models).toEqual([{ id: 'gpt-5.5', label: 'GPT-5.5' }])
    expect(result.error).toContain('ENOENT')
  })

  it('with no cache but a currently-configured model, falls back to a single synthesized entry rather than an empty selector', async () => {
    const promise = codexModelCatalogService.refresh('codex', 'gpt-5.6-sol')
    await Promise.resolve()
    const proc = spawnCalls[0].proc
    proc.emit('error', new Error('offline'))

    const result = await promise
    expect(result.source).toBe('empty')
    expect(result.models).toEqual([{ id: 'gpt-5.6-sol', label: 'gpt-5.6-sol', description: 'Currently configured model — catalogue unavailable' }])
  })

  it('with no cache and no current model, returns a genuinely empty list rather than inventing one', async () => {
    const promise = codexModelCatalogService.refresh('codex', null)
    await Promise.resolve()
    const proc = spawnCalls[0].proc
    proc.emit('error', new Error('offline'))

    const result = await promise
    expect(result.models).toEqual([])
  })

  it('getCached() never spawns a process — pure read of the cache/fallback', () => {
    repoState.cached = { models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }], fetchedAt: '2026-01-01T00:00:00.000Z' }
    const result = codexModelCatalogService.getCached(null)
    expect(result.source).toBe('cache')
    expect(spawnCalls).toHaveLength(0)
  })
})
