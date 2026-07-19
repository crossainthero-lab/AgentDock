// Resolves and discovers images genuinely produced or referenced by Codex in
// an assistant response — distinct from codex-attachment-service.ts (user->
// Codex input images, already complete, not touched here).
//
// Root cause this exists to fix: Codex's built-in `image_gen` tool call is
// completely invisible in `codex exec --experimental-json`'s event stream —
// confirmed by reading the TS SDK's compiled source (it does zero filtering,
// just `JSON.parse`s and yields each raw line) and then live-testing a real
// "generate an image" turn: the JSONL only ever contained `agent_message`/
// `command_execution` items, no `image_generation` item, even though the
// model's own text said "Generated the image using the built-in image
// generation tool." The richer `codex app-server` v2 protocol schema (`codex
// app-server generate-json-schema`) does define a dedicated
// `ImageGenerationThreadItem` (`type:"imageGeneration"`, fields `result`,
// `revisedPrompt`, `savedPath`) — but switching transports just to observe
// that one event was judged not worth the blast radius (a second wire
// protocol, a second process-lifecycle model) when the same information is
// available a simpler way: Codex's own skill docs (`~/.codex/skills/.system/
// imagegen/SKILL.md`, dumped verbatim by a live command_execution item)
// state the built-in tool always saves under `$CODEX_HOME/generated_images/
// <thread_id>/<call_id>.png` — confirmed by inspecting that exact directory
// immediately after a real generation turn. So instead of a new transport,
// this service snapshots that one thread-scoped directory before/after a
// turn and treats the diff as this turn's generated-image artifacts — using
// only filesystem I/O already available to the main process, no new wire
// protocol.
import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, resolve as resolvePath, sep } from 'node:path'
import { shell } from 'electron'
import type { AttachmentResolveResult } from '@shared/types'
import { workspaceRepo } from '../db/repositories/workspace-repo'
import { codexAttachmentService } from './codex-attachment-service'

const ALLOWED_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}
// Same ceiling used throughout the app's other image paths (media-service.ts,
// codex-attachment-service.ts) — not a documented Codex limit, a deliberate,
// consistent, practical cap.
const MAX_BYTES = 15 * 1024 * 1024

interface FileActionResult {
  ok: boolean
  error?: string
}

/** Real magic-byte signatures — verified against the claimed extension so a
 *  renamed/mislabeled file can never be rendered as if it were the type its
 *  extension claims (the extension alone, which is all media-service.ts and
 *  codex-attachment-service.ts checked before this, is trivially spoofable). */
const SIGNATURES: Array<{ mime: string; bytes: number[] }> = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] }
  // webp checked separately below (RIFF....WEBP — the middle 4 bytes are a
  // file-size field, not part of the signature).
]

function signatureMatches(buffer: Buffer, mime: string): boolean {
  if (mime === 'image/webp') {
    return (
      buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
    )
  }
  const sig = SIGNATURES.find((s) => s.mime === mime)
  if (!sig) return false
  if (buffer.length < sig.bytes.length) return false
  return sig.bytes.every((b, i) => buffer[i] === b)
}

export function codexHome(): string {
  return process.env.CODEX_HOME ? resolvePath(process.env.CODEX_HOME) : resolvePath(homedir(), '.codex')
}

export function generatedImagesDir(threadId: string): string {
  return resolvePath(codexHome(), 'generated_images', threadId)
}

function isWithinDir(dir: string, target: string): boolean {
  const dirLower = resolvePath(dir).toLowerCase()
  const targetLower = resolvePath(target).toLowerCase()
  return targetLower === dirLower || targetLower.startsWith(dirLower + sep)
}

function isImageFile(name: string): boolean {
  return name.toLowerCase().slice(name.lastIndexOf('.')) in ALLOWED_EXTENSIONS
}

async function listImageFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isFile() && isImageFile(e.name)).map((e) => resolvePath(dir, e.name))
  } catch {
    return []
  }
}

export const codexResponseImageService = {
  /** Snapshot of every image file currently in a thread's generated_images
   *  directory — call before a turn starts (on a resumed thread, where prior
   *  turns may have already generated images) so the after-turn diff only
   *  contains genuinely new files. */
  async snapshotDir(threadId: string | null): Promise<Set<string>> {
    if (!threadId) return new Set()
    return new Set(await listImageFiles(generatedImagesDir(threadId)))
  },

  /** Files present now but not in `before` — sorted oldest-first by
   *  birthtime so multiple images generated in one turn render in the order
   *  Codex actually produced them, not directory-listing order. */
  async diffNewImages(threadId: string | null, before: Set<string>): Promise<string[]> {
    if (!threadId) return []
    const after = await listImageFiles(generatedImagesDir(threadId))
    const added = after.filter((p) => !before.has(p))
    if (added.length <= 1) return added
    const withTimes = await Promise.all(
      added.map(async (p) => {
        try {
          const s = await stat(p)
          return { p, t: s.birthtimeMs || s.mtimeMs }
        } catch {
          return { p, t: 0 }
        }
      })
    )
    return withTimes.sort((a, b) => a.t - b.t).map((w) => w.p)
  },

  /** Reads a response-image artifact back as a data URL — restricted to
   *  exactly the three locations a genuine Codex-response image can live in:
   *  the active workspace (Markdown-referenced screenshots/local files), this
   *  session's own attachment storage (round-tripping a path the model
   *  echoed back), or this thread's own generated_images directory (built-in
   *  image_gen output). Anything else — an arbitrary path Codex merely
   *  printed — is refused, never rendered. */
  async resolve(params: { sessionId: string; workspaceId: string | null; threadId: string | null; requestedPath: string }): Promise<AttachmentResolveResult> {
    const resolvedRoot = resolveAllowedRoot(params)
    if (!resolvedRoot) return { error: 'This image is not in a location Codex is allowed to reference.' }

    const ext = extname(resolvedRoot).toLowerCase()
    const mime = ALLOWED_EXTENSIONS[ext]
    if (!mime) return { error: `Unsupported image type "${ext || '(none)'}".` }

    if (!existsSync(resolvedRoot)) return { error: 'This image is no longer available.' }

    let stats
    try {
      stats = await stat(resolvedRoot)
    } catch {
      return { error: 'This image is no longer available.' }
    }
    if (!stats.isFile()) return { error: 'Not a file.' }
    if (stats.size > MAX_BYTES) return { error: 'Image is too large to preview (over 15 MB).' }
    if (stats.size === 0) return { error: 'Image file is empty.' }

    let buffer: Buffer
    try {
      buffer = await readFile(resolvedRoot)
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to read image.' }
    }

    if (!signatureMatches(buffer, mime)) {
      return { error: 'This file\'s contents do not match its image extension and were not rendered.' }
    }

    return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}` }
  },

  async revealInFolder(params: { sessionId: string; workspaceId: string | null; threadId: string | null; requestedPath: string }): Promise<FileActionResult> {
    const resolvedRoot = resolveAllowedRoot(params)
    if (!resolvedRoot) return { ok: false, error: 'This image is not in a location Codex is allowed to reference.' }
    shell.showItemInFolder(resolvedRoot)
    return { ok: true }
  },

  async openExternally(params: { sessionId: string; workspaceId: string | null; threadId: string | null; requestedPath: string }): Promise<FileActionResult> {
    const resolvedRoot = resolveAllowedRoot(params)
    if (!resolvedRoot) return { ok: false, error: 'This image is not in a location Codex is allowed to reference.' }
    const err = await shell.openPath(resolvedRoot)
    return err ? { ok: false, error: err } : { ok: true }
  }
}

/** The one containment check shared by resolve/reveal/open — a requested
 *  path is only ever honored if it resolves inside one of the three allowed
 *  roots. Absolute AND relative paths are both resolved the same way; an
 *  absolute path pointing outside every allowed root is rejected exactly
 *  like a `../../` traversal attempt would be (both just fail the same
 *  `isWithinDir` check), and any non-file-path input (a URL, `file://`, a
 *  custom scheme) never reaches here in the first place — callers only
 *  invoke this for the local-path branch, never for http(s)/data URLs. */
function resolveAllowedRoot(params: { sessionId: string; workspaceId: string | null; threadId: string | null; requestedPath: string }): string | null {
  const { sessionId, workspaceId, threadId, requestedPath } = params

  if (workspaceId) {
    const workspace = workspaceRepo.get(workspaceId)
    if (workspace) {
      const root = resolvePath(workspace.path)
      const target = resolvePath(root, requestedPath)
      if (isWithinDir(root, target)) return target
    }
  }

  const attachmentsDir = codexAttachmentService.attachmentsDirFor(sessionId)
  const attachmentTarget = resolvePath(attachmentsDir, requestedPath)
  if (isWithinDir(attachmentsDir, attachmentTarget)) return attachmentTarget
  // Also allow an already-absolute attachment path handed back verbatim.
  const attachmentAbsolute = resolvePath(requestedPath)
  if (isWithinDir(attachmentsDir, attachmentAbsolute)) return attachmentAbsolute

  if (threadId) {
    const dir = generatedImagesDir(threadId)
    const target = resolvePath(dir, requestedPath)
    if (isWithinDir(dir, target)) return target
    const absolute = resolvePath(requestedPath)
    if (isWithinDir(dir, absolute)) return absolute
  }

  return null
}
