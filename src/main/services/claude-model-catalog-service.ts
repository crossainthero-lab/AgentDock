// Fetches real, per-model reasoning-effort support from the Claude Agent
// SDK's `Query.supportedModels()` — the SDK's own live model-metadata
// method, confirmed genuinely real by calling it against the installed
// CLI: every non-Haiku model reports `supportsEffort: true` with
// `supportedEffortLevels: ["low","medium","high","xhigh","max"]` in that
// exact order; Haiku reports neither field at all (no effort concept for
// that model). This enriches AgentDock's existing static Claude model list
// (capability-registry.ts's claudeCapabilities.models, which this file
// does not replace or duplicate — only the reasoning-effort metadata is
// discovered live) rather than fabricating which levels each model
// supports.
//
// `Query.supportedModels()` resolves without ever sending a real prompt —
// confirmed live: a Query built with an input iterable that's never
// pushed to still resolves supportedModels() in ~1.2s (it's a control
// request over the same connection, not something that requires an actual
// turn). No prompt ever gets sent and no reply is ever generated — this
// costs process-startup time only, not an API call, and never appears as
// a chat message. Calling Query.interrupt() afterward was confirmed live
// to correctly terminate the underlying process without leaving anything
// running.
import type { AgentModelOption, AgentReasoningEffortOption } from '@shared/types'
import { getCapabilities } from '../agents/capability-registry'
import { claudeModelCatalogRepo } from '../db/repositories/claude-model-catalog-repo'

type ClaudeAgentSdkModule = typeof import('@anthropic-ai/claude-agent-sdk')

let sdkModulePromise: Promise<ClaudeAgentSdkModule> | null = null
function loadSdk(): Promise<ClaudeAgentSdkModule> {
  if (!sdkModulePromise) sdkModulePromise = import('@anthropic-ai/claude-agent-sdk')
  return sdkModulePromise
}

/** An async iterable that's queried (via Query.supportedModels()) but
 *  never actually pulled from for a real turn — next() simply never
 *  resolves, which is fine since the catalogue fetch never iterates the
 *  Query's message stream at all. */
class NeverInput implements AsyncIterable<never> {
  [Symbol.asyncIterator](): AsyncIterator<never> {
    return { next: (): Promise<IteratorResult<never>> => new Promise(() => {}) }
  }
}

interface RawModelInfo {
  value: string
  resolvedModel?: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
}

const FETCH_TIMEOUT_MS = 15_000
// Per the SDK's own Options.effort doc comment: "'high' — Deep reasoning
// (default)" — uniform across every effort-supporting model, not
// per-model, so this is a single confirmed constant, not a guess.
const DEFAULT_EFFORT = 'high'

const EFFORT_DESCRIPTIONS: Record<string, string> = {
  low: 'Fastest, lighter reasoning',
  medium: 'Balanced speed and depth',
  high: 'Deeper reasoning',
  xhigh: 'Even deeper reasoning',
  max: 'Maximum reasoning depth'
}

function capitalize(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1)
}

function toReasoningOptions(levels: string[] | undefined): AgentReasoningEffortOption[] | undefined {
  if (!levels || levels.length === 0) return undefined
  return levels.map((level) => ({ id: level, label: capitalize(level), description: EFFORT_DESCRIPTIONS[level] }))
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

async function fetchRawModels(executablePath: string, cwd: string): Promise<RawModelInfo[]> {
  const { query } = await loadSdk()
  const q = query({
    prompt: new NeverInput(),
    options: { cwd, pathToClaudeCodeExecutable: executablePath, includePartialMessages: false }
  })
  try {
    const models = await withTimeout(
      q.supportedModels(),
      FETCH_TIMEOUT_MS,
      `claude did not respond to supportedModels() within ${FETCH_TIMEOUT_MS}ms`
    )
    return models as unknown as RawModelInfo[]
  } finally {
    q.interrupt().catch(() => {})
  }
}

/** Matches a static capability-registry.ts model id (e.g. "fable") against
 *  the SDK's real ModelInfo rows, which use a different id shape (e.g.
 *  "claude-fable-5[1m]" with resolvedModel "claude-fable-5") — same
 *  fuzzy-includes matching SessionHeader.tsx's claudeModelDisplay already
 *  uses for the same reason (the CLI's real strings don't exactly equal
 *  AgentDock's short aliases). */
function findRawModel(raw: RawModelInfo[], staticId: string): RawModelInfo | undefined {
  return raw.find((r) => r.value === staticId || (r.resolvedModel ?? r.value).includes(staticId))
}

export const claudeModelCatalogService = {
  /** Fetches real per-model reasoning-effort support and merges it onto
   *  the existing static Claude model list. Throws on any failure —
   *  callers decide the fallback (cache, then the static list unenriched),
   *  never a fabricated partial result. */
  async fetchLive(executablePath: string, cwd: string): Promise<AgentModelOption[]> {
    const raw = await fetchRawModels(executablePath, cwd)
    const staticModels = getCapabilities('claude-code').models
    return staticModels.map((model) => {
      const match = findRawModel(raw, model.id)
      if (!match?.supportsEffort || !match.supportedEffortLevels?.length) return model
      return {
        ...model,
        supportedReasoningEfforts: toReasoningOptions(match.supportedEffortLevels),
        defaultReasoningEffort: match.supportedEffortLevels.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : match.supportedEffortLevels[0]
      }
    })
  },

  /** Does a real live fetch and, on success, caches it. On failure, falls
   *  back to the last cached catalogue, then to the plain static list
   *  (still fully usable for model selection — just without reasoning-
   *  effort options, which simply won't render). */
  async refresh(executablePath: string, cwd: string): Promise<AgentModelOption[]> {
    try {
      const models = await this.fetchLive(executablePath, cwd)
      claudeModelCatalogRepo.set({ models, fetchedAt: new Date().toISOString() })
      return models
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[claude-model-catalog] live fetch failed:', message)
      return this.getCached()
    }
  },

  /** Fast, non-blocking path for initial UI load — never spawns a
   *  process. */
  getCached(): AgentModelOption[] {
    const cached = claudeModelCatalogRepo.get()
    if (cached && cached.models.length > 0) return cached.models
    return getCapabilities('claude-code').models
  }
}
