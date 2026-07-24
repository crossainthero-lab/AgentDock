// Builds and shows the native right-click context menu for a file-explorer
// tree entry. Deliberately a genuine Electron `Menu` — no custom HTML/CSS
// context-menu component and no new UI dependency — which is what makes it
// "native-feeling" on every platform for free, including correct platform
// wording. Every action resolves the entry's path through the same
// workspace-containment check filesystem-service.ts uses for every other
// path-taking operation, so nothing here can act outside the active
// workspace.
import { clipboard, dialog, Menu, shell, type BrowserWindow } from 'electron'
import { getWorkspacePath, resolveWithinWorkspace } from './filesystem-service'
import { vscodeLauncherService } from './vscode-launcher-service'

function revealLabel(): string {
  if (process.platform === 'darwin') return 'Reveal in Finder'
  if (process.platform === 'win32') return 'Show in File Explorer'
  return 'Show in File Manager'
}

function showVsCodeError(window: BrowserWindow, error: string): void {
  void dialog.showMessageBox(window, {
    type: 'error',
    title: 'VS Code not found',
    message: error
  })
}

export const explorerContextMenuService = {
  /** `relPath` is the entry's own workspace-relative path (never empty —
   *  only real tree entries get a context menu, never the workspace root
   *  itself). Silently does nothing if the workspace/path no longer
   *  resolves (e.g. deleted between the right-click and this call) rather
   *  than showing a menu whose actions would all fail. */
  show(window: BrowserWindow, workspaceId: string, relPath: string, isDirectory: boolean): void {
    const root = getWorkspacePath(workspaceId)
    if (!root) return
    const target = resolveWithinWorkspace(root, relPath)
    if (!target) return

    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: isDirectory ? 'Open Folder in VS Code' : 'Open in VS Code',
        click: () => {
          void vscodeLauncherService.open(target).then((result) => {
            if (!result.ok && result.error) showVsCodeError(window, result.error)
          })
        }
      },
      {
        label: revealLabel(),
        click: () => {
          // A folder is opened directly; showItemInFolder on a directory
          // would instead open its PARENT with the folder merely selected
          // — openPath is the one that matches "open the folder directly".
          if (isDirectory) void shell.openPath(target)
          else shell.showItemInFolder(target)
        }
      },
      { type: 'separator' },
      {
        label: 'Copy Relative Path',
        click: () => clipboard.writeText(relPath)
      },
      {
        label: 'Copy Full Path',
        click: () => clipboard.writeText(target)
      }
    ]

    Menu.buildFromTemplate(template).popup({ window })
  }
}
