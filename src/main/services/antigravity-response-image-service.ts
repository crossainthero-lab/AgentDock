// Resolves images genuinely produced or referenced by Antigravity in an
// assistant response — a separate, parallel implementation from
// codex-response-image-service.ts (never modified; Codex's own is already
// complete). Antigravity has no equivalent of Codex's dedicated
// generated_images directory — confirmed via real captured tool-call lines
// (`● Create(C:/scratch/capture-test.txt) (ctrl+o to expand)`,
// `● Edit(<path>)`): files Antigravity creates/edits land directly in the
// active workspace, named by the model itself. AntigravityEventMapper.ts
// detects an image-extension path from a real Create/Edit tool_activity
// line and emits the same shared `response_artifacts` AgentEvent Codex's
// generated-image work already introduced — this service only owns
// validating and reading those paths back, restricted to the two roots a
// genuine Antigravity response image can live in: the active workspace, or
// this session's own attachment storage (round-tripping a path the model
// echoed back from a user-sent attachment).
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, resolve as resolvePath, sep } from 'node:path'
import { shell } from 'electron'
import type { AttachmentResolveResult } from '@shared/types'
import { workspaceRepo } from '../db/repositories/workspace-repo'
import { antigravityAttachmentService } from './antigravity-attachment-service'

const ALLOWED_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}
const MAX_BYTES = 15 * 1024 * 1024

interface FileActionResult {
  ok: boolean
  error?: string
}

const SIGNATURES: Array<{ mime: string; bytes: number[] }> = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] }
]

function signatureMatches(buffer: Buffer, mime: string): boolean {
  if (mime === 'image/webp') {
    return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP'
  }
  const sig = SIGNATURES.find((s) => s.mime === mime)
  if (!sig) return false
  if (buffer.length < sig.bytes.length) return false
  return sig.bytes.every((b, i) => buffer[i] === b)
}

function isWithinDir(dir: string, target: string): boolean {
  const dirLower = resolvePath(dir).toLowerCase()
  const targetLower = resolvePath(target).toLowerCase()
  return targetLower === dirLower || targetLower.startsWith(dirLower + sep)
}

function resolveAllowedRoot(params: { sessionId: string; workspaceId: string | null; requestedPath: string }): string | null {
  const { sessionId, workspaceId, requestedPath } = params

  if (workspaceId) {
    const workspace = workspaceRepo.get(workspaceId)
    if (workspace) {
      const root = resolvePath(workspace.path)
      const target = resolvePath(root, requestedPath)
      if (isWithinDir(root, target)) return target
    }
  }

  const attachmentsDir = antigravityAttachmentService.attachmentsDirFor(sessionId)
  const attachmentTarget = resolvePath(attachmentsDir, requestedPath)
  if (isWithinDir(attachmentsDir, attachmentTarget)) return attachmentTarget
  const attachmentAbsolute = resolvePath(requestedPath)
  if (isWithinDir(attachmentsDir, attachmentAbsolute)) return attachmentAbsolute

  return null
}

export const antigravityResponseImageService = {
  async resolve(params: { sessionId: string; workspaceId: string | null; requestedPath: string }): Promise<AttachmentResolveResult> {
    const resolved = resolveAllowedRoot(params)
    if (!resolved) return { error: 'This image is not in a location Antigravity is allowed to reference.' }

    const ext = extname(resolved).toLowerCase()
    const mime = ALLOWED_EXTENSIONS[ext]
    if (!mime) return { error: `Unsupported image type "${ext || '(none)'}".` }

    if (!existsSync(resolved)) return { error: 'This image is no longer available.' }

    let stats
    try {
      stats = await stat(resolved)
    } catch {
      return { error: 'This image is no longer available.' }
    }
    if (!stats.isFile()) return { error: 'Not a file.' }
    if (stats.size > MAX_BYTES) return { error: 'Image is too large to preview (over 15 MB).' }
    if (stats.size === 0) return { error: 'Image file is empty.' }

    let buffer: Buffer
    try {
      buffer = await readFile(resolved)
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to read image.' }
    }

    if (!signatureMatches(buffer, mime)) {
      return { error: "This file's contents do not match its image extension and were not rendered." }
    }

    return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}` }
  },

  async revealInFolder(params: { sessionId: string; workspaceId: string | null; requestedPath: string }): Promise<FileActionResult> {
    const resolved = resolveAllowedRoot(params)
    if (!resolved) return { ok: false, error: 'This image is not in a location Antigravity is allowed to reference.' }
    shell.showItemInFolder(resolved)
    return { ok: true }
  },

  async openExternally(params: { sessionId: string; workspaceId: string | null; requestedPath: string }): Promise<FileActionResult> {
    const resolved = resolveAllowedRoot(params)
    if (!resolved) return { ok: false, error: 'This image is not in a location Antigravity is allowed to reference.' }
    const err = await shell.openPath(resolved)
    return err ? { ok: false, error: err } : { ok: true }
  }
}
