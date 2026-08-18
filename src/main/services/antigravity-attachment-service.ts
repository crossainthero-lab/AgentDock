// Persists image attachments for Antigravity sessions — a separate,
// parallel implementation from codex-attachment-service.ts (never reused or
// modified; Codex's is already complete and untouched here), because the
// two agents' native image-input mechanisms are fundamentally different:
// Codex accepts a `--image <path>` CLI flag, but `agy` has no such flag at
// all (confirmed via `agy --help`/`agy exec --help` — no image/attach/file
// flag exists anywhere). Its real, genuine mechanism — confirmed in the
// real changelog ("Added alt+v as an alternative paste shortcut on Windows
// ... enabling reliable image pasting", "Allowed image pasting from the
// clipboard", "Fixed Windows ... clipboard image and file reading") and
// then verified live: writing a real PNG onto the OS clipboard and sending
// a literal Ctrl+V (0x16) into a real `agy -i` PTY session produced the
// screen line `▸ 📎 1 media attached (clipboard, 141 B, image/png)
// (ctrl+o to expand)` — is genuine OS-clipboard paste. AntigravityAdapter
// performs the actual paste choreography (write clipboard, send Ctrl+V,
// confirm via that exact screen marker, restore the user's original
// clipboard) at send time; this service only owns validated, persistent
// on-disk storage of the picked/pasted bytes so they survive an AgentDock
// restart and can be re-read at send time — the same storage-then-resolve
// shape codex-attachment-service.ts uses, independently implemented here
// under its own subdirectory to avoid any ambiguity about ownership.
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
// Same 15 MB ceiling used throughout the app's other image paths — not a
// documented agy limit (none was found), a deliberate, consistent cap.
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
  return resolvePath(app.getPath('userData'), 'attachments', 'antigravity', sessionId)
}

function validateExtension(path: string): { ext: string; mime: string } | { error: string } {
  const ext = extname(path).toLowerCase()
  const mime = ALLOWED_EXTENSIONS[ext]
  if (!mime) {
    return { error: `Unsupported image type "${ext || '(none)'}" — Antigravity's clipboard paste supports PNG, JPG, GIF, and WEBP.` }
  }
  return { ext, mime }
}

function isWithinDir(dir: string, target: string): boolean {
  const dirLower = resolvePath(dir).toLowerCase()
  const targetLower = resolvePath(target).toLowerCase()
  return targetLower === dirLower || targetLower.startsWith(dirLower + sep)
}

export const antigravityAttachmentService = {
  /** Exposes this session's attachment directory read-only, so
   *  AntigravityAdapter can re-read a saved file's bytes at send time to
   *  write them onto the OS clipboard. */
  attachmentsDirFor(sessionId: string): string {
    return attachmentsDir(sessionId)
  },

  async browse(window: BrowserWindow): Promise<string[]> {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile', 'multiSelections'],
      title: 'Attach images',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
    })
    if (result.canceled) return []
    return result.filePaths
  },

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

  async saveFromDataUrl(sessionId: string, dataUrl: string): Promise<AttachmentSaveResult> {
    const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
    if (!match) return { error: 'Invalid image data.' }
    const [, mime, base64] = match
    const ext = Object.entries(ALLOWED_EXTENSIONS).find(([, m]) => m === mime)?.[0]
    if (!ext) return { error: `Unsupported image type "${mime}" — Antigravity's clipboard paste supports PNG, JPG, GIF, and WEBP.` }

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
