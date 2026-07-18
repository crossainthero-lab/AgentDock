// Persists the last successfully-fetched Codex model catalogue (real
// app-server `model/list` data) so the selector isn't empty on a cold
// start while offline — reuses the generic key-value `settings` table
// under a distinct key rather than adding a new table for one cached blob.
import { getDatabase, persist } from '../database'
import { get, run } from '../sqlite-adapter'
import type { AgentModelOption } from '@shared/types'

const CATALOG_KEY = 'codexModelCatalog'

export interface CachedCodexModelCatalog {
  models: AgentModelOption[]
  fetchedAt: string
}

export const codexModelCatalogRepo = {
  get(): CachedCodexModelCatalog | null {
    const row = get<{ value_json: string }>(getDatabase(), 'SELECT value_json FROM settings WHERE key = @key', { key: CATALOG_KEY })
    return row ? (JSON.parse(row.value_json) as CachedCodexModelCatalog) : null
  },

  set(catalog: CachedCodexModelCatalog): void {
    run(
      getDatabase(),
      'INSERT INTO settings (key, value_json) VALUES (@key, @valueJson) ON CONFLICT(key) DO UPDATE SET value_json = @valueJson',
      { key: CATALOG_KEY, valueJson: JSON.stringify(catalog) }
    )
    persist()
  }
}
