import type React from 'react'
import { useRef, useState } from 'react'
import { Square, ArrowUp, Paperclip } from 'lucide-react'
import { getAgentDock } from '../../lib/agentDockClient'
import { AttachmentThumbnail } from './AttachmentThumbnail'
import { FileAttachmentChip } from './FileAttachmentChip'
import './PromptComposer.css'

interface PendingFile {
  relPath: string
  fileName: string
  size: number | null
}

interface PromptComposerProps {
  disabled: boolean
  disabledReason: string | null
  isRunning: boolean
  onSend: (text: string, images?: string[]) => void
  onInterrupt: () => void
  /** Codex and Antigravity today — each has a genuine native image-input
   *  mechanism (Codex: local-file path via its SDK; Antigravity: real OS-
   *  clipboard paste, see AntigravityAdapter.ts). An image attached while
   *  this is false (Claude, or any image type Codex/Antigravity don't
   *  natively accept) still works — it just goes through the same
   *  workspace-copy fallback as every other non-image file below, rather
   *  than being silently dropped. */
  imagesEnabled: boolean
  /** Which agent's native-image attachment IPC namespace to save/browse
   *  through — defaults to 'codex' so existing Codex behavior is
   *  unaffected. Irrelevant when imagesEnabled is false. */
  attachmentBackend?: 'codex' | 'antigravity'
  /** Needed to scope saved attachments to this session's own persistent
   *  storage directory — null only while no session is open, in which case
   *  imagesEnabled is also effectively moot (composer is disabled). */
  sessionId: string | null
  /** Needed for the generic file-attachment fallback (copies into the
   *  workspace via filesystem-service.ts) — null only while no session/
   *  project is open, same as sessionId. */
  workspaceId?: string | null
}

const NATIVE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const NATIVE_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
// Every attachment that isn't routed through a native image path (any file
// type Codex/Antigravity aren't confirmed to accept, plus every attachment
// at all for Claude, which has no native attachment mechanism whatsoever)
// gets copied here instead — a normal, visible folder in the project rather
// than a hidden one, so the user can find/clean it up like any other file.
const ATTACHMENTS_FOLDER = 'agentdock-attachments'

function extOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot >= 0 ? path.slice(dot).toLowerCase() : ''
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file.'))
    reader.readAsDataURL(file)
  })
}

export function PromptComposer({
  disabled,
  disabledReason,
  isRunning,
  onSend,
  onInterrupt,
  imagesEnabled,
  attachmentBackend = 'codex',
  sessionId,
  workspaceId
}: PromptComposerProps): React.JSX.Element {
  const [text, setText] = useState('')
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [attaching, setAttaching] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Generic file attachment (copy-into-workspace fallback) works for any
  // agent, unlike the native image path below which only Codex/Antigravity
  // support — this is the gate for the attach button/drag/paste existing
  // at all.
  const canAttachAnything = !!sessionId && !!workspaceId && !disabled
  const canAttachNativeImage = imagesEnabled && canAttachAnything
  const canSend = !disabled && !isRunning && (text.trim().length > 0 || pendingImages.length > 0 || pendingFiles.length > 0)
  // Resolved lazily at the point of use, not eagerly on every render — the
  // composer renders (with attachments fully disabled) in contexts with no
  // bridge installed, e.g. tests with sessionId=null, and getAgentDock()
  // throws if window.agentDock isn't present.
  const getAttachmentApi = () => (attachmentBackend === 'antigravity' ? getAgentDock().antigravity : getAgentDock().codex)

  async function saveFromPath(sourcePath: string): Promise<void> {
    if (!sessionId) return
    const result = await getAttachmentApi().saveAttachmentFromPath(sessionId, sourcePath)
    if (result.path) setPendingImages((prev) => [...prev, result.path as string])
    else setAttachError(result.error ?? 'Could not attach this image.')
  }

  async function saveFromFile(file: File): Promise<void> {
    if (!sessionId) return
    if (!NATIVE_IMAGE_MIME.has(file.type)) {
      setAttachError(`Unsupported image type "${file.type || '(unknown)'}" — only PNG, JPG, GIF, and WEBP are supported.`)
      return
    }
    let dataUrl: string
    try {
      dataUrl = await readFileAsDataUrl(file)
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : 'Failed to read the image.')
      return
    }
    const result = await getAttachmentApi().saveAttachmentFromDataUrl(sessionId, dataUrl)
    if (result.path) setPendingImages((prev) => [...prev, result.path as string])
    else setAttachError(result.error ?? 'Could not attach this image.')
  }

  /** The generic fallback: copies a file already on disk into this
   *  project's attachments folder and tracks it by workspace-relative
   *  path — used for every non-image file, and for images too whenever
   *  this agent has no native image-input mechanism. */
  async function attachFileFromPath(sourcePath: string): Promise<void> {
    if (!workspaceId) return
    const result = await getAgentDock().filesystem.importFileAutoRename(workspaceId, ATTACHMENTS_FOLDER, sourcePath)
    if (result.relPath) {
      setPendingFiles((prev) => [...prev, { relPath: result.relPath as string, fileName: result.targetName, size: result.size ?? null }])
    } else {
      setAttachError(result.error ?? 'Could not attach this file.')
    }
  }

  async function attachFileFromBlob(file: File): Promise<void> {
    if (!workspaceId) return
    let dataUrl: string
    try {
      dataUrl = await readFileAsDataUrl(file)
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : 'Failed to read the file.')
      return
    }
    const result = await getAgentDock().filesystem.importFromDataUrl(workspaceId, ATTACHMENTS_FOLDER, file.name || 'attachment', dataUrl)
    if (result.relPath) {
      setPendingFiles((prev) => [...prev, { relPath: result.relPath as string, fileName: result.targetName, size: result.size ?? null }])
    } else {
      setAttachError(result.error ?? 'Could not attach this file.')
    }
  }

  /** Routes one real source path (from the native file picker) to the best
   *  available mechanism: a native image upload when this agent supports
   *  one and the extension is one it's confirmed to accept, the generic
   *  workspace-copy fallback otherwise. */
  async function attachFromPath(sourcePath: string): Promise<void> {
    if (canAttachNativeImage && NATIVE_IMAGE_EXTENSIONS.has(extOf(sourcePath))) {
      await saveFromPath(sourcePath)
      return
    }
    await attachFileFromPath(sourcePath)
  }

  /** Same routing for a dropped/pasted in-memory file (no reliable path
   *  under contextIsolation — see filesystem-service.ts's importFromDataUrl
   *  doc comment). */
  async function attachFromBlob(file: File): Promise<void> {
    if (canAttachNativeImage && NATIVE_IMAGE_MIME.has(file.type)) {
      await saveFromFile(file)
      return
    }
    await attachFileFromBlob(file)
  }

  async function handleAttachClick(): Promise<void> {
    if (!canAttachAnything) return
    setAttachError(null)
    setAttaching(true)
    try {
      const paths = await getAgentDock().filesystem.browseImportFiles()
      for (const path of paths) await attachFromPath(path)
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : 'Could not open the file picker.')
    } finally {
      setAttaching(false)
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>): void {
    if (!canAttachAnything) return
    e.preventDefault()
    setDragActive(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    setAttachError(null)
    setAttaching(true)
    void Promise.all(files.map(attachFromBlob)).finally(() => setAttaching(false))
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    if (!canAttachAnything) return
    const items = Array.from(e.clipboardData.items).filter((i) => i.kind === 'file')
    if (items.length === 0) return
    e.preventDefault()
    const files = items.map((i) => i.getAsFile()).filter((f): f is File => f !== null)
    if (files.length === 0) return
    setAttachError(null)
    setAttaching(true)
    void Promise.all(files.map(attachFromBlob)).finally(() => setAttaching(false))
  }

  function removePendingImage(path: string): void {
    setPendingImages((prev) => prev.filter((p) => p !== path))
  }

  function removePendingFile(relPath: string): void {
    setPendingFiles((prev) => prev.filter((f) => f.relPath !== relPath))
  }

  function handleSend(): void {
    if (!canSend) return
    // The agent only ever receives real content through `text` (or the
    // native `images` array) — never a hidden/UI-only annotation — so the
    // attached-file paths are appended to the same text every agent sees,
    // exactly as if the user had typed them.
    const attachmentNote =
      pendingFiles.length > 0
        ? `\n\nAttached file${pendingFiles.length === 1 ? '' : 's'}:\n${pendingFiles.map((f) => `- ${f.relPath}`).join('\n')}`
        : ''
    onSend(`${text.trim()}${attachmentNote}`, pendingImages.length > 0 ? pendingImages : undefined)
    setText('')
    setPendingImages([])
    setPendingFiles([])
    setAttachError(null)
    textareaRef.current?.focus()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const reason = disabled ? disabledReason : isRunning ? null : !canSend ? 'Type a task or attach a file to send.' : null

  return (
    <div className="ad-composer">
      {attachError && (
        <div className="ad-composer__attach-error">
          <span>{attachError}</span>
          <button onClick={() => setAttachError(null)}>Dismiss</button>
        </div>
      )}
      <div
        className={`ad-composer__box${disabled ? ' ad-composer__box--disabled' : ''}${dragActive ? ' ad-composer__box--drag' : ''}`}
        title={reason ?? undefined}
        onDragOver={(e) => {
          if (!canAttachAnything) return
          e.preventDefault()
          setDragActive(true)
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
      >
        {(pendingImages.length > 0 || pendingFiles.length > 0) && (
          <div className="ad-composer__attachments">
            {pendingImages.map((path) => (
              <AttachmentThumbnail
                key={path}
                sessionId={sessionId as string}
                path={path}
                onRemove={() => removePendingImage(path)}
                backend={attachmentBackend}
              />
            ))}
            {pendingFiles.map((file) => (
              <FileAttachmentChip key={file.relPath} fileName={file.fileName} size={file.size} onRemove={() => removePendingFile(file.relPath)} />
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={disabled ? (disabledReason ?? 'Sending is unavailable right now.') : 'Tell the agent what to do…'}
          disabled={disabled}
          rows={3}
        />
        <div className="ad-composer__toolbar">
          <span className="ad-composer__toolbar-left">
            <button
              className="ad-composer__attach"
              onClick={() => void handleAttachClick()}
              disabled={!canAttachAnything || attaching}
              title="Attach files"
              type="button"
            >
              <Paperclip size={14} />
            </button>
            <span className="ad-composer__hint">
              <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
            </span>
          </span>
          {isRunning ? (
            <button className="ad-composer__stop" onClick={onInterrupt} title="Interrupt the current task">
              <Square size={13} />
              Stop
            </button>
          ) : (
            <button className="ad-composer__send" onClick={handleSend} disabled={!canSend} title={reason ?? 'Send'}>
              <ArrowUp size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
