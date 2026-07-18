// Backs the rich Markdown renderer's link/image affordances. Every method
// here is workspace-scoped and path-validated — the renderer never gets
// unrestricted filesystem access; it can only ask "resolve/open/reveal this
// path, if it's inside this specific workspace" and the main process is the
// one that decides whether that's true.
import { stat, readFile } from 'node:fs/promises'
import { extname, resolve as resolvePath, sep } from 'node:path'
import { shell } from 'electron'
import { workspaceRepo } from '../db/repositories/workspace-repo'

const ALLOWED_IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
}
const MAX_IMAGE_BYTES = 15 * 1024 * 1024

export interface ResolveImageResult {
  dataUrl?: string
  error?: string
}

export interface FileActionResult {
  ok: boolean
  error?: string
}

/** Resolves `requestedPath` against `workspacePath` and returns the
 *  absolute path ONLY if it's still inside the workspace root — handles
 *  both relative paths (joined under the root) and absolute paths (which
 *  `path.resolve` would otherwise honor as-is, so they need the same
 *  containment check, not a free pass). Case-insensitive compare, matching
 *  Windows' default filesystem semantics (this project's actual target). */
function resolveWithinWorkspace(workspacePath: string, requestedPath: string): string | null {
  const root = resolvePath(workspacePath)
  const target = resolvePath(root, requestedPath)
  const rootLower = root.toLowerCase()
  const targetLower = target.toLowerCase()
  if (targetLower !== rootLower && !targetLower.startsWith(rootLower + sep)) return null
  return target
}

function getWorkspaceOrError(workspaceId: string): { path: string } | { error: string } {
  const workspace = workspaceRepo.get(workspaceId)
  if (!workspace) return { error: 'Workspace not found.' }
  return { path: workspace.path }
}

export const mediaService = {
  /** Reads a local image file and returns it as a data URL — this is the
   *  ENTIRE mechanism for local image display; no custom protocol handler,
   *  no relaxed CSP/webSecurity. `data:` URLs are already permitted by the
   *  existing strict CSP's `img-src`. */
  async resolveWorkspaceImage(workspaceId: string, requestedPath: string): Promise<ResolveImageResult> {
    const workspace = getWorkspaceOrError(workspaceId)
    if ('error' in workspace) return workspace

    const resolved = resolveWithinWorkspace(workspace.path, requestedPath)
    if (!resolved) return { error: 'This image is outside the workspace and cannot be displayed.' }

    const ext = extname(resolved).toLowerCase()
    const mime = ALLOWED_IMAGE_MIME[ext]
    if (!mime) return { error: `Unsupported image type "${ext || '(none)'}".` }

    let stats
    try {
      stats = await stat(resolved)
    } catch {
      return { error: 'Image file not found.' }
    }
    if (!stats.isFile()) return { error: 'Not a file.' }
    if (stats.size > MAX_IMAGE_BYTES) return { error: 'Image is too large to preview (over 15 MB).' }

    try {
      const buffer = await readFile(resolved)
      return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}` }
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to read image.' }
    }
  },

  async revealInFolder(workspaceId: string, requestedPath: string): Promise<FileActionResult> {
    const workspace = getWorkspaceOrError(workspaceId)
    if ('error' in workspace) return { ok: false, error: workspace.error }
    const resolved = resolveWithinWorkspace(workspace.path, requestedPath)
    if (!resolved) return { ok: false, error: 'Path is outside the workspace.' }
    shell.showItemInFolder(resolved)
    return { ok: true }
  },

  async openLocalPath(workspaceId: string, requestedPath: string): Promise<FileActionResult> {
    const workspace = getWorkspaceOrError(workspaceId)
    if ('error' in workspace) return { ok: false, error: workspace.error }
    const resolved = resolveWithinWorkspace(workspace.path, requestedPath)
    if (!resolved) return { ok: false, error: 'Path is outside the workspace.' }
    const err = await shell.openPath(resolved)
    return err ? { ok: false, error: err } : { ok: true }
  },

  /** Opens a URL in the OS default browser/mail client — never inside the
   *  Electron window. Only http/https/mailto are allowed; anything else
   *  (javascript:, data:, vbscript:, file:, custom app schemes, ...) is
   *  refused here, as defense-in-depth alongside the renderer's own
   *  equivalent check. */
  async openExternalLink(url: string): Promise<FileActionResult> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { ok: false, error: 'Invalid URL.' }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') {
      return { ok: false, error: `Refusing to open unsafe link protocol "${parsed.protocol}".` }
    }
    await shell.openExternal(url)
    return { ok: true }
  }
}
