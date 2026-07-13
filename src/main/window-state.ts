import { app, type Rectangle } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface WindowState extends Rectangle {
  isMaximized: boolean
}

const DEFAULT_STATE: WindowState = { x: 100, y: 100, width: 1440, height: 900, isMaximized: false }

function statePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

export function loadWindowState(): WindowState {
  try {
    const raw = readFileSync(statePath(), 'utf8')
    return { ...DEFAULT_STATE, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_STATE
  }
}

export function saveWindowState(state: WindowState): void {
  try {
    writeFileSync(statePath(), JSON.stringify(state))
  } catch {
    // Non-fatal — window position is a convenience, not critical state.
  }
}
