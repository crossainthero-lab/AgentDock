import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let userDataDir: string
let showOpenDialogMock: ReturnType<typeof vi.fn>

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? userDataDir : tmpdir()) },
  dialog: { showOpenDialog: (...args: unknown[]) => showOpenDialogMock(...args) }
}))

// codexAttachmentService reads app.getPath('userData') lazily inside each
// method (not at module load), so importing after userDataDir is assigned
// in beforeEach is unnecessary — but the mock itself must be registered
// before the import, which vi.mock's hoisting already guarantees.
import { codexAttachmentService } from '../../src/main/services/codex-attachment-service'

const SESSION_ID = 's1'

function makePng(bytes = 100): Buffer {
  return Buffer.alloc(bytes, 1)
}

describe('codexAttachmentService', () => {
  let sourceDir: string

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'agentdock-attachments-userdata-'))
    sourceDir = mkdtempSync(join(tmpdir(), 'agentdock-attachments-source-'))
    showOpenDialogMock = vi.fn()
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(sourceDir, { recursive: true, force: true })
  })

  describe('saveFromPath', () => {
    it('copies a valid PNG into this session\'s persistent attachment directory under a new random name', async () => {
      const src = join(sourceDir, 'original.png')
      writeFileSync(src, makePng())

      const result = await codexAttachmentService.saveFromPath(SESSION_ID, src)

      expect(result.error).toBeUndefined()
      expect(result.path).toBeDefined()
      expect(result.path).not.toBe(src)
      expect(result.path).toContain(userDataDir)
    })

    it('rejects an unsupported extension with a clear error, never calling into Codex', async () => {
      const src = join(sourceDir, 'vector.svg')
      writeFileSync(src, '<svg></svg>')

      const result = await codexAttachmentService.saveFromPath(SESSION_ID, src)

      expect(result.path).toBeUndefined()
      expect(result.error).toMatch(/unsupported image type/i)
    })

    it('rejects a missing file with a clear error', async () => {
      const result = await codexAttachmentService.saveFromPath(SESSION_ID, join(sourceDir, 'does-not-exist.png'))

      expect(result.path).toBeUndefined()
      expect(result.error).toMatch(/not found/i)
    })

    it('rejects an oversized file', async () => {
      const src = join(sourceDir, 'huge.png')
      writeFileSync(src, makePng(15 * 1024 * 1024 + 1))

      const result = await codexAttachmentService.saveFromPath(SESSION_ID, src)

      expect(result.path).toBeUndefined()
      expect(result.error).toMatch(/too large/i)
    })

    it('rejects an empty file', async () => {
      const src = join(sourceDir, 'empty.png')
      writeFileSync(src, Buffer.alloc(0))

      const result = await codexAttachmentService.saveFromPath(SESSION_ID, src)

      expect(result.path).toBeUndefined()
      expect(result.error).toMatch(/empty/i)
    })

    it('accepts every documented supported extension (png, jpg, jpeg, gif, webp)', async () => {
      for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp']) {
        const src = join(sourceDir, `img.${ext}`)
        writeFileSync(src, makePng())
        const result = await codexAttachmentService.saveFromPath(SESSION_ID, src)
        expect(result.error, `expected .${ext} to be accepted`).toBeUndefined()
        expect(result.path).toBeDefined()
      }
    })
  })

  describe('saveFromDataUrl', () => {
    it('decodes and saves a valid base64 PNG data URL', async () => {
      const dataUrl = `data:image/png;base64,${makePng().toString('base64')}`
      const result = await codexAttachmentService.saveFromDataUrl(SESSION_ID, dataUrl)

      expect(result.error).toBeUndefined()
      expect(result.path).toContain(userDataDir)
    })

    it('rejects a malformed data URL', async () => {
      const result = await codexAttachmentService.saveFromDataUrl(SESSION_ID, 'not-a-data-url')
      expect(result.path).toBeUndefined()
      expect(result.error).toMatch(/invalid image data/i)
    })

    it('rejects an unsupported MIME type', async () => {
      const dataUrl = `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`
      const result = await codexAttachmentService.saveFromDataUrl(SESSION_ID, dataUrl)
      expect(result.path).toBeUndefined()
      expect(result.error).toMatch(/unsupported image type/i)
    })

    it('rejects an oversized data URL payload', async () => {
      const dataUrl = `data:image/png;base64,${makePng(15 * 1024 * 1024 + 1).toString('base64')}`
      const result = await codexAttachmentService.saveFromDataUrl(SESSION_ID, dataUrl)
      expect(result.path).toBeUndefined()
      expect(result.error).toMatch(/too large/i)
    })
  })

  describe('resolve', () => {
    it('reads back a saved attachment as a data URL', async () => {
      const src = join(sourceDir, 'a.png')
      writeFileSync(src, makePng())
      const saved = await codexAttachmentService.saveFromPath(SESSION_ID, src)

      const resolved = await codexAttachmentService.resolve(SESSION_ID, saved.path as string)

      expect(resolved.error).toBeUndefined()
      expect(resolved.dataUrl).toMatch(/^data:image\/png;base64,/)
    })

    it('refuses to resolve a path outside this session\'s own attachment directory (containment check)', async () => {
      const src = join(sourceDir, 'a.png')
      writeFileSync(src, makePng())
      const savedForOtherSession = await codexAttachmentService.saveFromPath('other-session', src)

      const resolved = await codexAttachmentService.resolve(SESSION_ID, savedForOtherSession.path as string)

      expect(resolved.dataUrl).toBeUndefined()
      expect(resolved.error).toMatch(/not part of this session/i)
    })

    it('reports a missing file distinctly from a containment failure', async () => {
      const src = join(sourceDir, 'a.png')
      writeFileSync(src, makePng())
      const saved = await codexAttachmentService.saveFromPath(SESSION_ID, src)
      rmSync(saved.path as string)

      const resolved = await codexAttachmentService.resolve(SESSION_ID, saved.path as string)

      expect(resolved.dataUrl).toBeUndefined()
      expect(resolved.error).toMatch(/not found/i)
    })
  })

  describe('browse', () => {
    it('returns the picked file paths from the native dialog, unmodified and not yet copied into storage', async () => {
      showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/a.png', '/b.jpg'] })

      const paths = await codexAttachmentService.browse({} as never)

      expect(paths).toEqual(['/a.png', '/b.jpg'])
    })

    it('returns an empty array when the picker is cancelled', async () => {
      showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] })

      const paths = await codexAttachmentService.browse({} as never)

      expect(paths).toEqual([])
    })
  })
})
