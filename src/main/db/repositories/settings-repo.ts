import { getDatabase, persist } from '../database'
import { get, run } from '../sqlite-adapter'
import type { Settings } from '@shared/types'

const SETTINGS_KEY = 'settings'

export const settingsRepo = {
  get(): Settings | null {
    const row = get<{ value_json: string }>(
      getDatabase(),
      'SELECT value_json FROM settings WHERE key = @key',
      { key: SETTINGS_KEY }
    )
    return row ? (JSON.parse(row.value_json) as Settings) : null
  },

  set(settings: Settings): void {
    run(
      getDatabase(),
      'INSERT INTO settings (key, value_json) VALUES (@key, @valueJson) ON CONFLICT(key) DO UPDATE SET value_json = @valueJson',
      { key: SETTINGS_KEY, valueJson: JSON.stringify(settings) }
    )
    persist()
  }
}
