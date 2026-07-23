// Backs the renderer's file-explorer side panel: lazy, one-directory-at-a-
// time listing, text/image preview, importing external files into the
// workspace, and lightweight per-expanded-directory watching. Every method
// is workspace-scoped and path-validated (see resolveWithinWorkspace) —
// same containment discipline as media-service.ts/git.ts's pathFor, just
// covering directory listing and file writes too. No recursive/background
// scanning of the whole tree ever happens; only what the renderer explicitly
// asks for (an expanded folder, an opened file) touches disk.
import { existsSync } from 'node:fs'
import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { copyFile, mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, resolve as resolvePath, sep } from 'node:path'
import { dialog, type BrowserWindow } from 'electron'
import type { FileEntry, FileListResult, FilePreview, ImportFileResult } from '@shared/types'
import { workspaceRepo } from '../db/repositories/workspace-repo'

// Directories never listed/watched — mirrors what a normal project's own
// .gitignore typically excludes, kept as a fixed allowlist-style set rather
// than parsing .gitignore itself (simpler, predictable, and this panel is
// deliberately not a full IDE explorer).
const IGNORED_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'release',
  '.next',
  '.nuxt',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.idea',
  '.vscode-test',
  '.DS_Store',
  'Thumbs.db',
  'coverage',
  '.pytest_cache',
  '.tox',
  '.mypy_cache'
])

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_TEXT_CHARS = 300_000
const MAX_IMAGE_BYTES = 15 * 1024 * 1024
const MAX_IMPORT_BYTES = 25 * 1024 * 1024
const WATCH_DEBOUNCE_MS = 200

/** Resolves `relPath` against `workspacePath` and returns the absolute path
 *  ONLY if it's still inside the workspace root — same case-insensitive
 *  (Windows-appropriate) containment check media-service.ts uses, applied
 *  here to directory listing and file writes as well as reads. Exported for
 *  explorer-context-menu-service.ts, which needs the identical containment
 *  check for its own path-taking actions (reveal/copy-path/open-in-VS-Code)
 *  rather than duplicating it. */
export function resolveWithinWorkspace(workspacePath: string, relPath: string): string | null {
  const root = resolvePath(workspacePath)
  const cleaned = relPath.replace(/^[/\\]+/, '')
  const target = resolvePath(root, cleaned)
  const rootLower = root.toLowerCase()
  const targetLower = target.toLowerCase()
  if (targetLower !== rootLower && !targetLower.startsWith(rootLower + sep)) return null
  return target
}

function toRelPath(root: string, abs: string): string {
  const rel = abs.slice(resolvePath(root).length).replace(/^[\\/]+/, '')
  return rel.split(sep).join('/')
}

export function getWorkspacePath(workspaceId: string): string | null {
  return workspaceRepo.get(workspaceId)?.path ?? null
}

/** Picks a name that doesn't already exist in `dir` — "name.ext", then
 *  "name (1).ext", "name (2).ext", etc. Used only by the auto-attach paths
 *  (chat attachments), which have no interactive rename/replace/skip
 *  prompt to fall back to; the File Explorer's own "+" import flow instead
 *  surfaces real conflicts via checkImportConflicts for the user to
 *  resolve, and never calls this. */
function uniqueNameIn(dir: string, name: string): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let candidate = name
  let n = 1
  while (existsSync(resolvePath(dir, candidate)) && n < 1000) {
    candidate = `${stem} (${n})${ext}`
    n += 1
  }
  return candidate
}

/** Sniffs the first 8KB for a NUL byte — the same cheap, reliable heuristic
 *  git/most editors use to decide "text vs binary" without a full content
 *  scan or a MIME-type dependency. */
async function looksBinary(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(8000)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true
    }
    return false
  } finally {
    await handle.close()
  }
}

interface WatchEntry {
  watcher: FSWatcher
  refCount: number
  timer: ReturnType<typeof setTimeout> | null
}

// Keyed by `${workspaceId}::${relPath}`, refcounted so React StrictMode's
// double-mount (or two panels watching the same folder) never leaks a
// duplicate native watcher, and so a folder stays watched exactly as long as
// something in the renderer actually has it expanded — never the whole tree
// upfront.
const watchers = new Map<string, WatchEntry>()

function watchKey(workspaceId: string, relPath: string): string {
  return `${workspaceId}::${relPath}`
}

export const filesystemService = {
  async list(workspaceId: string, relPath: string): Promise<FileListResult> {
    const root = getWorkspacePath(workspaceId)
    if (!root) return { entries: [], error: 'Workspace not found.' }
    const target = resolveWithinWorkspace(root, relPath)
    if (!target) return { entries: [], error: 'Path is outside the workspace.' }

    let dirents
    try {
      dirents = await readdir(target, { withFileTypes: true })
    } catch (err) {
      return { entries: [], error: err instanceof Error ? err.message : 'Failed to read directory.' }
    }

    const entries: FileEntry[] = []
    for (const dirent of dirents) {
      if (IGNORED_NAMES.has(dirent.name)) continue
      const abs = resolvePath(target, dirent.name)
      const isDirectory = dirent.isDirectory()
      let size: number | null = null
      let mtimeMs: number | null = null
      if (!isDirectory) {
        try {
          const stats = await stat(abs)
          size = stats.size
          mtimeMs = stats.mtimeMs
        } catch {
          continue // vanished between readdir and stat
        }
      }
      entries.push({ name: dirent.name, relPath: toRelPath(root, abs), isDirectory, size, mtimeMs })
    }

    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    return { entries }
  },

  async read(workspaceId: string, relPath: string): Promise<FilePreview> {
    const root = getWorkspacePath(workspaceId)
    if (!root) return { kind: 'error', error: 'Workspace not found.' }
    const target = resolveWithinWorkspace(root, relPath)
    if (!target) return { kind: 'error', error: 'Path is outside the workspace.' }

    let stats
    try {
      stats = await stat(target)
    } catch {
      return { kind: 'error', error: 'File not found.' }
    }
    if (!stats.isFile()) return { kind: 'error', error: 'Not a file.' }

    const ext = extname(target).toLowerCase()
    const imageMime = IMAGE_MIME[ext]
    if (imageMime) {
      if (stats.size > MAX_IMAGE_BYTES) return { kind: 'unsupported', reason: 'Image is too large to preview (over 15 MB).' }
      try {
        const buffer = await readFile(target)
        return { kind: 'image', dataUrl: `data:${imageMime};base64,${buffer.toString('base64')}` }
      } catch (err) {
        return { kind: 'error', error: err instanceof Error ? err.message : 'Failed to read image.' }
      }
    }

    if (stats.size > MAX_TEXT_BYTES) return { kind: 'unsupported', reason: 'File is too large to preview (over 2 MB).' }
    if (stats.size === 0) return { kind: 'text', content: '', truncated: false }

    if (await looksBinary(target)) return { kind: 'unsupported', reason: 'This file type cannot be previewed.' }

    try {
      const full = await readFile(target, 'utf8')
      const truncated = full.length > MAX_TEXT_CHARS
      return { kind: 'text', content: truncated ? full.slice(0, MAX_TEXT_CHARS) : full, truncated }
    } catch (err) {
      return { kind: 'error', error: err instanceof Error ? err.message : 'Failed to read file.' }
    }
  },

  /** Returns which of `fileNames` already exist in `destRelPath` — the
   *  renderer uses this to prompt rename/replace/cancel before importing,
   *  rather than ever silently overwriting. */
  async checkImportConflicts(workspaceId: string, destRelPath: string, fileNames: string[]): Promise<string[]> {
    const root = getWorkspacePath(workspaceId)
    if (!root) return []
    const destAbs = resolveWithinWorkspace(root, destRelPath)
    if (!destAbs) return []
    return fileNames.filter((name) => existsSync(resolvePath(destAbs, name)))
  },

  /** Opens a native multi-select picker for any normal file type — unlike
   *  the agent-attachment pickers (codex/antigravity-attachment-service.ts),
   *  this isn't restricted to images since anything can be dropped into a
   *  project folder. Returns real source paths, not yet copied anywhere. */
  async browseImportFiles(window: BrowserWindow): Promise<string[]> {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile', 'multiSelections'],
      title: 'Import files into project'
    })
    if (result.canceled) return []
    return result.filePaths
  },

  /** Copies each already-on-disk source file into `destRelPath`, under
   *  `targetName` (which the renderer has already resolved for any naming
   *  conflict via checkImportConflicts — rename/replace/skip). Never
   *  invents a name or overwrites something the caller didn't ask it to. */
  async importFiles(
    workspaceId: string,
    destRelPath: string,
    files: { sourcePath: string; targetName: string }[]
  ): Promise<ImportFileResult[]> {
    const root = getWorkspacePath(workspaceId)
    if (!root) {
      return files.map((f) => ({ sourceName: basename(f.sourcePath), targetName: f.targetName, relPath: null, error: 'Workspace not found.' }))
    }
    const destAbs = resolveWithinWorkspace(root, destRelPath)
    if (!destAbs) {
      return files.map((f) => ({
        sourceName: basename(f.sourcePath),
        targetName: f.targetName,
        relPath: null,
        error: 'Destination is outside the workspace.'
      }))
    }

    try {
      await mkdir(destAbs, { recursive: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to prepare the destination folder.'
      return files.map((f) => ({ sourceName: basename(f.sourcePath), targetName: f.targetName, relPath: null, error: message }))
    }

    const results: ImportFileResult[] = []
    for (const file of files) {
      const sourceName = basename(file.sourcePath)
      const targetAbs = resolvePath(destAbs, file.targetName)
      const withinDestLower = resolvePath(targetAbs).toLowerCase()
      const destAbsLower = resolvePath(destAbs).toLowerCase()
      if (withinDestLower !== destAbsLower && !withinDestLower.startsWith(destAbsLower + sep)) {
        results.push({ sourceName, targetName: file.targetName, relPath: null, error: 'Target path is outside the destination folder.' })
        continue
      }
      let sourceStats
      try {
        sourceStats = await stat(file.sourcePath)
      } catch {
        results.push({ sourceName, targetName: file.targetName, relPath: null, error: 'Source file not found.' })
        continue
      }
      if (sourceStats.size > MAX_IMPORT_BYTES) {
        results.push({
          sourceName,
          targetName: file.targetName,
          relPath: null,
          error: `File is too large to import (over ${MAX_IMPORT_BYTES / (1024 * 1024)} MB).`
        })
        continue
      }
      try {
        await copyFile(file.sourcePath, targetAbs)
        results.push({ sourceName, targetName: file.targetName, relPath: toRelPath(root, targetAbs), size: sourceStats.size })
      } catch (err) {
        results.push({ sourceName, targetName: file.targetName, relPath: null, error: err instanceof Error ? err.message : 'Failed to copy file.' })
      }
    }
    return results
  },

  /** Copies one already-on-disk file into `destRelPath`, auto-uniquifying
   *  the name on collision (never overwrites, never prompts) — used by the
   *  chat composer's quick-attach flow, which has no interactive
   *  rename/replace/skip dialog to fall back to (unlike the File Explorer's
   *  own "+" import, which uses importFiles + an explicit user choice). */
  async importFileAutoRename(workspaceId: string, destRelPath: string, sourcePath: string): Promise<ImportFileResult> {
    const sourceName = basename(sourcePath)
    const root = getWorkspacePath(workspaceId)
    if (!root) return { sourceName, targetName: sourceName, relPath: null, error: 'Workspace not found.' }
    const destAbs = resolveWithinWorkspace(root, destRelPath)
    if (!destAbs) return { sourceName, targetName: sourceName, relPath: null, error: 'Destination is outside the workspace.' }

    let sourceStats
    try {
      sourceStats = await stat(sourcePath)
    } catch {
      return { sourceName, targetName: sourceName, relPath: null, error: 'Source file not found.' }
    }
    if (!sourceStats.isFile()) return { sourceName, targetName: sourceName, relPath: null, error: 'Not a file.' }
    if (sourceStats.size > MAX_IMPORT_BYTES) {
      return { sourceName, targetName: sourceName, relPath: null, error: `File is too large to attach (over ${MAX_IMPORT_BYTES / (1024 * 1024)} MB).` }
    }

    try {
      await mkdir(destAbs, { recursive: true })
    } catch (err) {
      return { sourceName, targetName: sourceName, relPath: null, error: err instanceof Error ? err.message : 'Failed to prepare the destination folder.' }
    }

    const targetName = uniqueNameIn(destAbs, sourceName)
    const targetAbs = resolvePath(destAbs, targetName)
    try {
      await copyFile(sourcePath, targetAbs)
      return { sourceName, targetName, relPath: toRelPath(root, targetAbs), size: sourceStats.size }
    } catch (err) {
      return { sourceName, targetName, relPath: null, error: err instanceof Error ? err.message : 'Failed to copy file.' }
    }
  },

  /** Same as importFileAutoRename, but for a pasted/dropped file delivered
   *  from the renderer as a data URL — drag-and-drop and clipboard paste
   *  hand back an in-memory blob, not a reliable filesystem path (Electron
   *  no longer exposes one under contextIsolation), so this decodes and
   *  writes the bytes directly, the same way codex-attachment-service.ts's
   *  saveFromDataUrl does for its own (app-userData-scoped) storage. */
  async importFromDataUrl(workspaceId: string, destRelPath: string, fileName: string, dataUrl: string): Promise<ImportFileResult> {
    const root = getWorkspacePath(workspaceId)
    if (!root) return { sourceName: fileName, targetName: fileName, relPath: null, error: 'Workspace not found.' }
    const destAbs = resolveWithinWorkspace(root, destRelPath)
    if (!destAbs) return { sourceName: fileName, targetName: fileName, relPath: null, error: 'Destination is outside the workspace.' }

    const match = /^data:([^;]*);base64,(.+)$/.exec(dataUrl)
    if (!match) return { sourceName: fileName, targetName: fileName, relPath: null, error: 'Invalid file data.' }
    let buffer: Buffer
    try {
      buffer = Buffer.from(match[2], 'base64')
    } catch {
      return { sourceName: fileName, targetName: fileName, relPath: null, error: 'Invalid file data.' }
    }
    if (buffer.length === 0) return { sourceName: fileName, targetName: fileName, relPath: null, error: 'File is empty.' }
    if (buffer.length > MAX_IMPORT_BYTES) {
      return { sourceName: fileName, targetName: fileName, relPath: null, error: `File is too large to attach (over ${MAX_IMPORT_BYTES / (1024 * 1024)} MB).` }
    }

    try {
      await mkdir(destAbs, { recursive: true })
    } catch (err) {
      return { sourceName: fileName, targetName: fileName, relPath: null, error: err instanceof Error ? err.message : 'Failed to prepare the destination folder.' }
    }

    const targetName = uniqueNameIn(destAbs, fileName)
    const targetAbs = resolvePath(destAbs, targetName)
    try {
      await writeFile(targetAbs, buffer)
      return { sourceName: fileName, targetName, relPath: toRelPath(root, targetAbs), size: buffer.length }
    } catch (err) {
      return { sourceName: fileName, targetName, relPath: null, error: err instanceof Error ? err.message : 'Failed to save file.' }
    }
  },

  /** Starts (or ref-counts an existing) non-recursive watch on one
   *  directory — only ever called for a directory the renderer currently
   *  has expanded. `onChange` fires (debounced) on any create/rename/modify
   *  event inside it. */
  watch(workspaceId: string, relPath: string, onChange: (workspaceId: string, relPath: string) => void): { ok: boolean; error?: string } {
    const root = getWorkspacePath(workspaceId)
    if (!root) return { ok: false, error: 'Workspace not found.' }
    const target = resolveWithinWorkspace(root, relPath)
    if (!target) return { ok: false, error: 'Path is outside the workspace.' }

    const key = watchKey(workspaceId, relPath)
    const existing = watchers.get(key)
    if (existing) {
      existing.refCount += 1
      return { ok: true }
    }

    try {
      const entry: WatchEntry = { refCount: 1, timer: null, watcher: null as unknown as FSWatcher }
      entry.watcher = fsWatch(target, { persistent: false }, () => {
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = setTimeout(() => onChange(workspaceId, relPath), WATCH_DEBOUNCE_MS)
      })
      watchers.set(key, entry)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to watch directory.' }
    }
  },

  unwatch(workspaceId: string, relPath: string): void {
    const key = watchKey(workspaceId, relPath)
    const entry = watchers.get(key)
    if (!entry) return
    entry.refCount -= 1
    if (entry.refCount <= 0) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.watcher.close()
      watchers.delete(key)
    }
  }
}
