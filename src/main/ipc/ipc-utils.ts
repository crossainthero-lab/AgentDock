// On macOS, closing every window does not quit the app (see index.ts's
// window-all-closed handler) — the process stays alive and Dock/'activate'
// can recreate the main window later, which re-runs registerAllIpc(). Plain
// `ipcMain.handle` throws "Attempted to register a second handler" the
// second time the same channel is registered, and plain `ipcMain.on` just
// keeps stacking duplicate listeners (each firing once per registration,
// closed over an increasingly stale `window`). Both of these were the root
// cause of the reported Dock-reopen crash. Clearing any existing
// handler/listeners for a channel before adding the new one makes
// re-registration safe and ensures handlers always close over the current
// window.
import { ipcMain } from 'electron'

export function safeHandle(channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, listener)
}

export function safeOn(channel: string, listener: (event: Electron.IpcMainEvent, ...args: any[]) => void): void {
  ipcMain.removeAllListeners(channel)
  ipcMain.on(channel, listener)
}
