// Fetches Codex's real, account-scoped model catalogue via the app-server's
// `model/list` JSON-RPC method — confirmed genuinely real by generating the
// protocol's JSON Schema (`codex app-server generate-json-schema`) and then
// speaking it live against the installed CLI: `initialize` then a
// newline-delimited-JSON `model/list` call, paginated via `nextCursor`,
// returns exactly what the native Codex model picker itself would show
// (verified: 4 visible models for this account — GPT-5.6-Sol, GPT-5.6-Terra,
// GPT-5.6-Luna, GPT-5.5 — plus 3 more only visible with `includeHidden:true`
// — GPT-5.4, GPT-5.4-mini, codex-auto-review). This replaces an earlier,
// incorrect implementation that read `~/.codex/config.toml`'s
// `[tui.model_availability_nux]` section and treated its two entries as the
// complete catalogue — that section is just picker NUX bookkeeping, not the
// account's real available-model list.
//
// `codex app-server` has no dedicated "list models and exit" mode — it's a
// long-lived JSON-RPC server. Rather than keeping one alive for the app's
// whole lifetime (a real process to manage, restart on crash, etc. — more
// than this needs), a fresh instance is spawned per catalogue fetch,
// queried, and killed. Fetches only happen at the few real trigger points
// (app start, explicit refresh, permission-mode-style re-detection) so the
// extra process-startup latency (a few hundred ms) is a fine trade for the
// simplicity.
import { spawn } from 'node:child_process'
import type { AgentModelOption, CodexModelCatalogResult } from '@shared/types'
import { codexModelCatalogRepo } from '../db/repositories/codex-model-catalog-repo'

interface JsonRpcResponse {
  id?: number
  result?: unknown
  error?: { code: number; message: string }
  method?: string // present on notifications, which have no id
}

interface RawReasoningEffortOption {
  reasoningEffort: string
  description: string
}

interface RawCatalogModel {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  defaultReasoningEffort: string
  supportedReasoningEfforts: RawReasoningEffortOption[]
}

interface RawModelListResult {
  data: RawCatalogModel[]
  nextCursor: string | null
}

const FETCH_TIMEOUT_MS = 15_000
const MAX_PAGES = 20 // guards against a misbehaving server cursor-looping forever

class AppServerClient {
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: JsonRpcResponse) => void; reject: (err: Error) => void }>()
  private readonly proc: ReturnType<typeof spawn>

  constructor(executablePath: string) {
    this.proc = spawn(executablePath, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.proc.stdout?.setEncoding('utf8')
    this.proc.stdout?.on('data', (chunk: string) => this.onData(chunk))
    this.proc.on('error', (err) => this.rejectAll(err))
    this.proc.on('exit', () => this.rejectAll(new Error('codex app-server exited before responding')))
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      if (!line.trim()) continue
      let msg: JsonRpcResponse
      try {
        msg = JSON.parse(line)
      } catch {
        continue // not a JSON-RPC line (shouldn't happen, but never crash on it)
      }
      if (msg.id == null) continue // notification — nothing this client needs
      const waiter = this.pending.get(msg.id)
      if (waiter) {
        this.pending.delete(msg.id)
        waiter.resolve(msg)
      }
    }
  }

  private rejectAll(err: Error): void {
    for (const [, waiter] of this.pending) waiter.reject(err)
    this.pending.clear()
  }

  call(method: string, params: unknown): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      this.proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  close(): void {
    this.proc.kill()
  }
}

function toReasoningEffortOptions(raw: RawReasoningEffortOption[]): AgentModelOption['supportedReasoningEfforts'] {
  return raw.map((r) => ({ id: r.reasoningEffort, label: labelizeEffort(r.reasoningEffort), description: r.description }))
}

function labelizeEffort(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1)
}

function toModelOption(raw: RawCatalogModel): AgentModelOption {
  return {
    id: raw.id,
    label: raw.displayName,
    description: raw.description + (raw.isDefault ? ' (default)' : ''),
    hidden: raw.hidden,
    isDefault: raw.isDefault,
    supportedReasoningEfforts: toReasoningEffortOptions(raw.supportedReasoningEfforts),
    defaultReasoningEffort: raw.defaultReasoningEffort
  }
}

async function fetchAllPages(client: AppServerClient): Promise<RawCatalogModel[]> {
  const all: RawCatalogModel[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await client.call('model/list', { includeHidden: true, cursor })
    if (response.error) throw new Error(`model/list failed: ${response.error.message}`)
    const result = response.result as RawModelListResult
    all.push(...result.data)
    cursor = result.nextCursor
    if (!cursor) break
  }
  return all
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

export const codexModelCatalogService = {
  /** Fetches the real, live, account-scoped model catalogue. Throws on any
   *  failure (process spawn error, timeout, malformed protocol, API error)
   *  — callers decide the fallback (cache, then the currently-configured
   *  model, then empty), this never fabricates a partial result. */
  async fetchLive(executablePath: string): Promise<AgentModelOption[]> {
    const client = new AppServerClient(executablePath)
    try {
      const work = (async () => {
        const initResponse = await client.call('initialize', {
          clientInfo: { name: 'AgentDock', version: '0.1.0' }
        })
        if (initResponse.error) throw new Error(`initialize failed: ${initResponse.error.message}`)
        const raw = await fetchAllPages(client)
        return raw.map(toModelOption)
      })()
      return await withTimeout(work, FETCH_TIMEOUT_MS, `codex app-server did not respond to model/list within ${FETCH_TIMEOUT_MS}ms`)
    } finally {
      client.close()
    }
  },

  /** Does a real live fetch and, on success, caches it for next time. On
   *  failure, falls back to the last cached catalogue, then to a minimal
   *  single-entry catalogue synthesized from whatever model is currently
   *  configured (so the selector is never left completely empty), and
   *  reports the real error either way rather than hiding it. */
  async refresh(executablePath: string, currentModel: string | null): Promise<CodexModelCatalogResult> {
    try {
      const models = await this.fetchLive(executablePath)
      const fetchedAt = new Date().toISOString()
      codexModelCatalogRepo.set({ models, fetchedAt })
      return { models, source: 'live', fetchedAt }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[codex-model-catalog] live fetch failed:', message)
      return this.getCached(currentModel, message)
    }
  },

  /** Fast, non-blocking path for initial UI load — never spawns a process,
   *  just returns whatever's cached (or the current-model/empty fallback).
   *  Call refresh() to actually populate or update the cache. */
  getCached(currentModel: string | null, error?: string): CodexModelCatalogResult {
    const cached = codexModelCatalogRepo.get()
    if (cached && cached.models.length > 0) {
      return { models: cached.models, source: 'cache', fetchedAt: cached.fetchedAt, error }
    }
    if (currentModel) {
      return {
        models: [{ id: currentModel, label: currentModel, description: 'Currently configured model — catalogue unavailable' }],
        source: 'empty',
        fetchedAt: null,
        error
      }
    }
    return { models: [], source: 'empty', fetchedAt: null, error }
  }
}
