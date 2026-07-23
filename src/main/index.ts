import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import { initDatabase, closeDatabase } from './db/database'
import { settingsService } from './services/settings-service'
import { ptyService } from './services/pty-service'
import { childProcessService } from './services/child-process-service'
import { loadWindowState, saveWindowState } from './window-state'
import { registerAllIpc } from './ipc'
import { detectionService } from './services/detection-service'
import { augmentPathForMacGuiLaunch } from './services/executable-resolver'
import { codexModelCatalogService } from './services/codex-model-catalog-service'
import { claudeModelCatalogService } from './services/claude-model-catalog-service'
import { workspaceService } from './services/workspace-service'

// Must run before anything else spawns a child process (detection, git,
// model-catalog probes all follow) — see the function's own doc comment
// for why a Finder/Dock-launched mac app needs this and a Terminal-launched
// one doesn't.
augmentPathForMacGuiLaunch()

// Test-only isolation hook: redirects the sqlite DB (and, since Electron
// scopes its single-instance lock file to userData too, the instance lock
// itself) to a disposable directory instead of the real user's AgentDock
// data. Never set outside of automated E2E runs, so real usage is
// unaffected.
const customUserDataDir = process.env['AGENTDOCK_USER_DATA_DIR']
if (customUserDataDir) app.setPath('userData', customUserDataDir)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null

/** Matches tokens.css's --color-bg-app for the initial paint, before the
 *  renderer loads — avoids a flash of the wrong theme's background on
 *  startup. Reflects the user's persisted appearance choice, or the OS
 *  theme when they've left it on 'system'. */
function initialBackgroundColor(): string {
  const appearance = settingsService.get().appearance
  const dark = appearance === 'system' ? nativeTheme.shouldUseDarkColors : appearance === 'dark'
  return dark ? '#17181c' : '#f5f6f8'
}

function createWindow(): void {
  const state = loadWindowState()
  const isMac = process.platform === 'darwin'

  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 960,
    minHeight: 600,
    show: false,
    // frame:false (used on Windows/Linux) suppresses macOS's native
    // traffic-light controls entirely — there's no way to get them back
    // once the frame itself is gone. On mac, keep the real frame (the
    // default) and only hide its title bar via titleBarStyle so the
    // traffic lights still render, inset to align with this app's own
    // custom titlebar height; TitleBar.tsx hides its Windows-style
    // custom min/max/close buttons on darwin to avoid a duplicate set.
    frame: isMac,
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 13 } } : { titleBarStyle: 'hidden' as const }),
    backgroundColor: initialBackgroundColor(),
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

  // Root cause of the reported Dock-reopen crash: window-all-closed (below)
  // closes the database and, on macOS, deliberately leaves the app running
  // with zero windows (Apple HIG convention — see its own comment). Without
  // reinitializing here, a Dock click after closing every window created a
  // fresh BrowserWindow whose IPC handlers immediately hit a closed
  // database ("Database accessed before initDatabase() completed"). Also
  // re-registers IPC (via registerAllIpc inside createWindow) against the
  // new window — safe because every handler now goes through
  // safeHandle/safeOn (see ipc-utils.ts), which replace rather than stack
  // on top of the previous window's now-stale handlers.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void initDatabase().then(createWindow)
    }
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
  // early, so the user's home directory stands in (supportedModels()
  // doesn't depend on which workspace is active; it's account/plan-scoped).
  // CRITICAL (portability fix): NOT process.cwd() — for a packaged app
  // launched from the Start Menu that resolves to an unpredictable
  // directory (often the install location itself, which a per-user install
  // may not have write access inside), unlike app.getPath('home').
  void (async () => {
    const customPath = settingsService.get().agents['claude-code'].customPath
    const detection = await detectionService.detect('claude-code', customPath).catch(() => null)
    if (detection?.installed && detection.executablePath) {
      const cwd = workspaceService.getCurrent()?.path ?? app.getPath('home')
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
