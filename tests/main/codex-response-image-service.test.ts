import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let codexHomeDir: string
let workspaceDir: string
let attachmentsUserDataDir: string

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
  app: { getPath: (name: string) => (name === 'userData' ? attachmentsUserDataDir : tmpdir()) },
  dialog: { showOpenDialog: vi.fn() }
}))

vi.mock('../../src/main/db/repositories/workspace-repo', () => ({
  workspaceRepo: {
    get: (id: string) => (id === 'w1' ? { id: 'w1', path: workspaceDir, name: 'w', addedAt: '', lastOpenedAt: '' } : null)
  }
}))

import { codexResponseImageService, codexHome, generatedImagesDir } from '../../src/main/services/codex-response-image-service'

const REAL_PNG = Buffer.from('89504e470d0a1a0a', 'hex')
const REAL_JPEG = Buffer.from('ffd8ffdb', 'hex')
const FAKE_PNG_BY_EXTENSION_ONLY = Buffer.from('this is not really a png')

function writePng(path: string, buf: Buffer = REAL_PNG): void {
  writeFileSync(path, buf)
}

describe('codexResponseImageService', () => {
  beforeEach(() => {
    codexHomeDir = mkdtempSync(join(tmpdir(), 'agentdock-codexhome-'))
    workspaceDir = mkdtempSync(join(tmpdir(), 'agentdock-workspace-'))
    attachmentsUserDataDir = mkdtempSync(join(tmpdir(), 'agentdock-userdata-'))
    process.env.CODEX_HOME = codexHomeDir
  })

  afterEach(() => {
    delete process.env.CODEX_HOME
    rmSync(codexHomeDir, { recursive: true, force: true })
    rmSync(workspaceDir, { recursive: true, force: true })
    rmSync(attachmentsUserDataDir, { recursive: true, force: true })
  })

  it('codexHome() respects CODEX_HOME when set', () => {
    expect(codexHome()).toBe(codexHomeDir)
  })

  describe('snapshotDir / diffNewImages', () => {
    it('returns an empty set for a null threadId (a fresh thread cannot have generated anything yet)', async () => {
      const snap = await codexResponseImageService.snapshotDir(null)
      expect(snap.size).toBe(0)
      const diff = await codexResponseImageService.diffNewImages(null, snap)
      expect(diff).toEqual([])
    })

    it('detects a newly-appeared image file since the snapshot, on a resumed thread', async () => {
      const threadId = 'thread-1'
      const dir = generatedImagesDir(threadId)
      mkdirSync(dir, { recursive: true })
      writePng(join(dir, 'existing.png'))

      const before = await codexResponseImageService.snapshotDir(threadId)
      expect(before.size).toBe(1)

      writePng(join(dir, 'new-call-id.png'))
      const diff = await codexResponseImageService.diffNewImages(threadId, before)
      expect(diff).toHaveLength(1)
      expect(diff[0]).toContain('new-call-id.png')
    })

    it('orders multiple new images oldest-first by creation time', async () => {
      const threadId = 'thread-2'
      const dir = generatedImagesDir(threadId)
      mkdirSync(dir, { recursive: true })
      const before = await codexResponseImageService.snapshotDir(threadId)

      writePng(join(dir, 'second.png'))
      await new Promise((r) => setTimeout(r, 10))
      writePng(join(dir, 'third.png'))

      const diff = await codexResponseImageService.diffNewImages(threadId, before)
      expect(diff.map((p) => p.split(/[/\\]/).pop())).toEqual(['second.png', 'third.png'])
    })

    it('ignores non-image files in the directory', async () => {
      const threadId = 'thread-3'
      const dir = generatedImagesDir(threadId)
      mkdirSync(dir, { recursive: true })
      const before = await codexResponseImageService.snapshotDir(threadId)
      writeFileSync(join(dir, 'notes.txt'), 'hello')
      const diff = await codexResponseImageService.diffNewImages(threadId, before)
      expect(diff).toEqual([])
    })
  })

  describe('resolve', () => {
    it('resolves a genuine generated-image path within the thread generated_images directory', async () => {
      const threadId = 'thread-resolve-1'
      const dir = generatedImagesDir(threadId)
      mkdirSync(dir, { recursive: true })
      const filePath = join(dir, 'call_abc.png')
      writePng(filePath)

      const result = await codexResponseImageService.resolve({ sessionId: 's1', workspaceId: null, threadId, requestedPath: filePath })
      expect(result.error).toBeUndefined()
      expect(result.dataUrl).toMatch(/^data:image\/png;base64,/)
    })

    it('resolves a Markdown-referenced relative path inside the workspace', async () => {
      const filePath = join(workspaceDir, 'screenshot.png')
      writePng(filePath)

      const result = await codexResponseImageService.resolve({
        sessionId: 's1',
        workspaceId: 'w1',
        threadId: null,
        requestedPath: 'screenshot.png'
      })
      expect(result.error).toBeUndefined()
      expect(result.dataUrl).toMatch(/^data:image\/png;base64,/)
    })

    it('resolves a real JPEG with the correct MIME type', async () => {
      const threadId = 'thread-resolve-jpeg'
      const dir = generatedImagesDir(threadId)
      mkdirSync(dir, { recursive: true })
      const filePath = join(dir, 'photo.jpg')
      writePng(filePath, REAL_JPEG)

      const result = await codexResponseImageService.resolve({ sessionId: 's1', workspaceId: null, threadId, requestedPath: filePath })
      expect(result.dataUrl).toMatch(/^data:image\/jpeg;base64,/)
    })

    it('refuses a path outside every allowed root (path traversal / arbitrary file)', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'agentdock-outside-'))
      const filePath = join(outsideDir, 'secret.png')
      writePng(filePath)

      const result = await codexResponseImageService.resolve({
        sessionId: 's1',
        workspaceId: 'w1',
        threadId: 'thread-x',
        requestedPath: filePath
      })
      expect(result.dataUrl).toBeUndefined()
      expect(result.error).toMatch(/not (in a location|part of)/i)
      rmSync(outsideDir, { recursive: true, force: true })
    })

    it('refuses a ../ traversal attempt out of the generated_images directory', async () => {
      const threadId = 'thread-traversal'
      const dir = generatedImagesDir(threadId)
      mkdirSync(dir, { recursive: true })

      const result = await codexResponseImageService.resolve({
        sessionId: 's1',
        workspaceId: null,
        threadId,
        requestedPath: '../../../../windows/win.ini'
      })
      expect(result.dataUrl).toBeUndefined()
      expect(result.error).toBeDefined()
    })

    it('rejects a file whose bytes do not match its claimed extension (signature validation)', async () => {
      const threadId = 'thread-signature'
      const dir = generatedImagesDir(threadId)
      mkdirSync(dir, { recursive: true })
      const filePath = join(dir, 'fake.png')
      writeFileSync(filePath, FAKE_PNG_BY_EXTENSION_ONLY)

      const result = await codexResponseImageService.resolve({ sessionId: 's1', workspaceId: null, threadId, requestedPath: filePath })
      expect(result.dataUrl).toBeUndefined()
      expect(result.error).toMatch(/do not match/i)
    })

    it('reports a missing file with a clean unavailable-artifact error', async () => {
      const threadId = 'thread-missing'
      const dir = generatedImagesDir(threadId)
      mkdirSync(dir, { recursive: true })

      const result = await codexResponseImageService.resolve({
        sessionId: 's1',
        workspaceId: null,
        threadId,
        requestedPath: join(dir, 'never-existed.png')
      })
      expect(result.dataUrl).toBeUndefined()
      expect(result.error).toMatch(/no longer available/i)
    })

    it('rejects an unsupported extension', async () => {
      const threadId = 'thread-svg'
      const dir = generatedImagesDir(threadId)
      mkdirSync(dir, { recursive: true })
      const filePath = join(dir, 'vector.svg')
      writeFileSync(filePath, '<svg></svg>')

      const result = await codexResponseImageService.resolve({ sessionId: 's1', workspaceId: null, threadId, requestedPath: filePath })
      expect(result.error).toMatch(/unsupported image type/i)
    })
  })
})
