// Persists the last successfully-fetched Claude model catalogue (real
// Query.supportedModels() data, enriched with per-model reasoning-effort
// support) so the selector isn't empty on a cold start while offline —
// reuses the generic key-value `settings` table under a distinct key,
// same pattern as codex-model-catalog-repo.ts.
import { getDatabase, persist } from '../database'
import { get, run } from '../sqlite-adapter'
import type { AgentModelOption } from '@shared/types'

const CATALOG_KEY = 'claudeModelCatalog'

export interface CachedClaudeModelCatalog {
  models: AgentModelOption[]
  fetchedAt: string
}

export const claudeModelCatalogRepo = {
  get(): CachedClaudeModelCatalog | null {
    const row = get<{ value_json: string }>(getDatabase(), 'SELECT value_json FROM settings WHERE key = @key', { key: CATALOG_KEY })
    return row ? (JSON.parse(row.value_json) as CachedClaudeModelCatalog) : null
  },

  set(catalog: CachedClaudeModelCatalog): void {
    run(
      getDatabase(),
      'INSERT INTO settings (key, value_json) VALUES (@key, @valueJson) ON CONFLICT(key) DO UPDATE SET value_json = @valueJson',
      { key: CATALOG_KEY, valueJson: JSON.stringify(catalog) }
    )
    persist()
  }
}
