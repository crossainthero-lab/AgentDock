import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { initDatabase, closeDatabase } from './db/database'
import { settingsService } from './services/settings-service'
import { ptyService } from './services/pty-service'
import { childProcessService } from './services/child-process-service'
import { loadWindowState, saveWindowState } from './window-state'
import { registerAllIpc } from './ipc'
import { detectionService } from './services/detection-service'
import { codexModelCatalogService } from './services/codex-model-catalog-service'
import { claudeModelCatalogService } from './services/claude-model-catalog-service'
import { workspaceService } from './services/workspace-service'

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const state = loadWindowState()

  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 960,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#111214',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  if (state.isMaximized) mainWindow.maximize()

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Defense-in-depth alongside the renderer's own link interception (see
  // MarkdownLink.tsx) — the window itself must never navigate to anything
  // other than its own app content. An external URL slipping past the
  // renderer's click handler (e.g. a real anchor's default browser
  // behavior) gets redirected to the OS browser instead of loading inside
  // this window.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isDevServer = !!process.env['ELECTRON_RENDERER_URL'] && url.startsWith(process.env['ELECTRON_RENDERER_URL'])
    const isAppFile = url.startsWith('file://')
    if (isDevServer || isAppFile) return
    event.preventDefault()
    void shell.openExternal(url)
  })

  const persistState = (): void => {
    if (!mainWindow) return
    const bounds = mainWindow.getBounds()
    saveWindowState({ ...bounds, isMaximized: mainWindow.isMaximized() })
  }
  mainWindow.on('close', persistState)
  mainWindow.on('resize', persistState)
  mainWindow.on('move', persistState)

  registerAllIpc(mainWindow)

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  await initDatabase()
  settingsService.ensureInitialized()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // Warms the Codex model catalogue cache on startup so the selector has
  // real data the first time a session opens, per the requirement that it
  // refresh "when AgentDock starts" — non-blocking and never fatal to
  // startup if Codex isn't installed or the fetch fails (refresh() itself
  // already falls back to the cache/current-model rather than throwing).
  void (async () => {
    const customPath = settingsService.get().agents.codex.customPath
    const detection = await detectionService.detect('codex', customPath).catch(() => null)
    if (detection?.installed && detection.executablePath) {
      await codexModelCatalogService.refresh(detection.executablePath, settingsService.get().agents.codex.model).catch(() => {})
    }
  })()

  // Same warm-cache treatment for Claude's reasoning-effort catalogue
  // (Query.supportedModels()) — no specific workspace is open yet this
  // early, so process.cwd() stands in (supportedModels() doesn't depend on
  // which workspace is active; it's account/plan-scoped).
  void (async () => {
    const customPath = settingsService.get().agents['claude-code'].customPath
    const detection = await detectionService.detect('claude-code', customPath).catch(() => null)
    if (detection?.installed && detection.executablePath) {
      const cwd = workspaceService.getCurrent()?.path ?? process.cwd()
      await claudeModelCatalogService.refresh(detection.executablePath, cwd).catch(() => {})
    }
  })()
})

app.on('window-all-closed', () => {
  ptyService.killAll()
  childProcessService.killAll()
  closeDatabase()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  ptyService.killAll()
  childProcessService.killAll()
  closeDatabase()
})
