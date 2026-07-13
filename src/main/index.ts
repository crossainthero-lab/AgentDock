import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { initDatabase, closeDatabase } from './db/database'
import { settingsService } from './services/settings-service'
import { ptyService } from './services/pty-service'
import { loadWindowState, saveWindowState } from './window-state'
import { registerAllIpc } from './ipc'

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
})

app.on('window-all-closed', () => {
  ptyService.killAll()
  closeDatabase()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  ptyService.killAll()
  closeDatabase()
})
