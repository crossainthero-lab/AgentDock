// Persists image attachments for Codex sessions — Codex's real native
// image-input mechanism is a local file path, not embedded base64: the SDK
// (@openai/codex-sdk) accepts `UserInput[]` entries of the form
// `{ type: 'local_image', path }`, and its compiled source (dist/index.js)
// shows this becomes a real `--image <path>` flag on the underlying `codex
// exec` invocation — confirmed by reading that source directly, then
// verified live: sending two differently-colored real PNGs and asking
// Codex to compare them correctly answered "red, blue" in order. PNG, JPG,
// GIF, and BMP were each independently confirmed live to work; WEBP is
// included per Codex's own model response naming it as a valid format when
// handed an unreadable file. SVG is deliberately excluded — it's a vector
// format the vision pipeline was never confirmed to rasterize.
//
// Files are copied into a session-scoped directory under this app's own
// userData (never the user's workspace — that would pollute their project
// with hidden files) so a picked/pasted image survives independently of
// wherever the user's original file came from, satisfying "preserve image
// attachments after restarting AgentDock" without depending on a source
// path that might move, get deleted, or point at a temp/clipboard
// location that no longer exists by the time the session is reopened.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, resolve as resolvePath, sep } from 'node:path'
import { app, dialog, type BrowserWindow } from 'electron'

const ALLOWED_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}
// Same 15 MB ceiling media-service.ts already uses for inline Markdown
// images — not a Codex-documented limit (none was found), but a
// deliberate, consistent, practical cap so a huge file can't hang the
// picker/paste flow or bloat the attachments directory.
const MAX_BYTES = 15 * 1024 * 1024

export interface AttachmentSaveResult {
  path?: string
  error?: string
}

export interface AttachmentResolveResult {
  dataUrl?: string
  error?: string
}

function attachmentsDir(sessionId: string): string {
  return resolvePath(app.getPath('userData'), 'attachments', sessionId)
}

function validateExtension(path: string): { ext: string; mime: string } | { error: string } {
  const ext = extname(path).toLowerCase()
  const mime = ALLOWED_EXTENSIONS[ext]
  if (!mime) {
    return { error: `Unsupported image type "${ext || '(none)'}" — Codex supports PNG, JPG, GIF, and WEBP.` }
  }
  return { ext, mime }
}

function isWithinDir(dir: string, target: string): boolean {
  const dirLower = resolvePath(dir).toLowerCase()
  const targetLower = resolvePath(target).toLowerCase()
  return targetLower === dirLower || targetLower.startsWith(dirLower + sep)
}

export const codexAttachmentService = {
  /** Exposes this session's attachment directory read-only, for
   *  codex-response-image-service.ts's containment check (a Codex response
   *  may legitimately reference back a path from a user-sent attachment) —
   *  no behavior change to this service's own save/resolve logic. */
  attachmentsDirFor(sessionId: string): string {
    return attachmentsDir(sessionId)
  },

  /** Opens a native multi-select image picker. Returns the user's real,
   *  original file paths — not yet copied into persistent storage; call
   *  saveFromPath() for each one the caller wants to actually keep. */
  async browse(window: BrowserWindow): Promise<string[]> {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile', 'multiSelections'],
      title: 'Attach images',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
    })
    if (result.canceled) return []
    return result.filePaths
  },

  /** Copies a file the user picked/dropped (a real path already on disk)
   *  into this session's persistent attachment directory under a new
   *  random name — never reused across sessions, never a symlink/reference
   *  to the original, so the original moving or being deleted later can't
   *  break history. */
  async saveFromPath(sessionId: string, sourcePath: string): Promise<AttachmentSaveResult> {
    const validated = validateExtension(sourcePath)
    if ('error' in validated) return { error: validated.error }

    let stats
    try {
      stats = await stat(sourcePath)
    } catch {
      return { error: 'Image file not found.' }
    }
    if (!stats.isFile()) return { error: 'Not a file.' }
    if (stats.size > MAX_BYTES) return { error: `Image is too large (over ${MAX_BYTES / (1024 * 1024)} MB).` }
    if (stats.size === 0) return { error: 'Image file is empty.' }

    let buffer: Buffer
    try {
      buffer = await readFile(sourcePath)
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to read image.' }
    }
    return this.saveBuffer(sessionId, buffer, validated.ext)
  },

  /** Saves a pasted/dropped image delivered from the renderer as a data
   *  URL (clipboard and drag-and-drop content arrives as blobs in the DOM,
   *  not as a filesystem path AgentDock can trust — this decodes and
   *  validates it the same way a picked file is validated). */
  async saveFromDataUrl(sessionId: string, dataUrl: string): Promise<AttachmentSaveResult> {
    const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
    if (!match) return { error: 'Invalid image data.' }
    const [, mime, base64] = match
    const ext = Object.entries(ALLOWED_EXTENSIONS).find(([, m]) => m === mime)?.[0]
    if (!ext) return { error: `Unsupported image type "${mime}" — Codex supports PNG, JPG, GIF, and WEBP.` }

    let buffer: Buffer
    try {
      buffer = Buffer.from(base64, 'base64')
    } catch {
      return { error: 'Invalid image data.' }
    }
    if (buffer.length === 0) return { error: 'Image data is empty.' }
    if (buffer.length > MAX_BYTES) return { error: `Image is too large (over ${MAX_BYTES / (1024 * 1024)} MB).` }

    return this.saveBuffer(sessionId, buffer, ext)
  },

  async saveBuffer(sessionId: string, buffer: Buffer, ext: string): Promise<AttachmentSaveResult> {
    const dir = attachmentsDir(sessionId)
    try {
      await mkdir(dir, { recursive: true })
      const destPath = resolvePath(dir, `${randomUUID()}${ext}`)
      await writeFile(destPath, buffer)
      return { path: destPath }
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to save image.' }
    }
  },

  /** Reads a previously-saved attachment back as a data URL for display
   *  (thumbnails, the click-to-enlarge preview) — validated to be inside
   *  this exact session's own attachment directory, the same containment
   *  discipline media-service.ts applies for workspace images, just
   *  scoped to AgentDock's own managed storage instead of the user's
   *  project. */
  async resolve(sessionId: string, attachmentPath: string): Promise<AttachmentResolveResult> {
    const dir = attachmentsDir(sessionId)
    if (!isWithinDir(dir, attachmentPath)) return { error: 'This attachment is not part of this session.' }

    const validated = validateExtension(attachmentPath)
    if ('error' in validated) return { error: validated.error }

    if (!existsSync(attachmentPath)) return { error: 'Attachment file not found.' }

    try {
      const buffer = await readFile(attachmentPath)
      return { dataUrl: `data:${validated.mime};base64,${buffer.toString('base64')}` }
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to read attachment.' }
    }
  }
}
