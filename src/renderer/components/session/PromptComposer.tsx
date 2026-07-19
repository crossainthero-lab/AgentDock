import type React from 'react'
import { useRef, useState } from 'react'
import { Square, ArrowUp, Paperclip } from 'lucide-react'
import { getAgentDock } from '../../lib/agentDockClient'
import { AttachmentThumbnail } from './AttachmentThumbnail'
import './PromptComposer.css'

interface PromptComposerProps {
  disabled: boolean
  disabledReason: string | null
  isRunning: boolean
  onSend: (text: string, images?: string[]) => void
  onInterrupt: () => void
  /** Codex and Antigravity today — each has a genuine native image-input
   *  mechanism (Codex: local-file path via its SDK; Antigravity: real OS-
   *  clipboard paste, see AntigravityAdapter.ts), so the attachment button/
   *  drag/paste handling below is gated on this rather than being generic
   *  UI for every agent. Claude has no verified equivalent. */
  imagesEnabled: boolean
  /** Which agent's attachment IPC namespace to save/browse through —
   *  defaults to 'codex' so existing Codex behavior is unaffected. */
  attachmentBackend?: 'codex' | 'antigravity'
  /** Needed to scope saved attachments to this session's own persistent
   *  storage directory — null only while no session is open, in which case
   *  imagesEnabled is also effectively moot (composer is disabled). */
  sessionId: string | null
}

const ACCEPTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

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
  sessionId
}: PromptComposerProps): React.JSX.Element {
  const [text, setText] = useState('')
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const [attaching, setAttaching] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const canAttach = imagesEnabled && !!sessionId && !disabled
  const canSend = !disabled && !isRunning && (text.trim().length > 0 || pendingImages.length > 0)
  // Resolved lazily at the point of use, not eagerly on every render — the
  // composer renders (with attachments fully disabled) in contexts with no
  // bridge installed, e.g. Claude sessions/tests with imagesEnabled=false,
  // and getAgentDock() throws if window.agentDock isn't present.
  const getAttachmentApi = () => (attachmentBackend === 'antigravity' ? getAgentDock().antigravity : getAgentDock().codex)

  async function saveFromPath(sourcePath: string): Promise<void> {
    if (!sessionId) return
    const result = await getAttachmentApi().saveAttachmentFromPath(sessionId, sourcePath)
    if (result.path) setPendingImages((prev) => [...prev, result.path as string])
    else setAttachError(result.error ?? 'Could not attach this image.')
  }

  async function saveFromFile(file: File): Promise<void> {
    if (!sessionId) return
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
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

  async function handleAttachClick(): Promise<void> {
    if (!canAttach) return
    setAttachError(null)
    setAttaching(true)
    try {
      const paths = await getAttachmentApi().browseAttachments()
      for (const path of paths) await saveFromPath(path)
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : 'Could not open the file picker.')
    } finally {
      setAttaching(false)
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>): void {
    if (!canAttach) return
    e.preventDefault()
    setDragActive(false)
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
    if (files.length === 0) return
    setAttachError(null)
    setAttaching(true)
    void Promise.all(files.map(saveFromFile)).finally(() => setAttaching(false))
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    if (!canAttach) return
    const items = Array.from(e.clipboardData.items).filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
    if (items.length === 0) return
    e.preventDefault()
    const files = items.map((i) => i.getAsFile()).filter((f): f is File => f !== null)
    if (files.length === 0) return
    setAttachError(null)
    setAttaching(true)
    void Promise.all(files.map(saveFromFile)).finally(() => setAttaching(false))
  }

  function removePendingImage(path: string): void {
    setPendingImages((prev) => prev.filter((p) => p !== path))
  }

  function handleSend(): void {
    if (!canSend) return
    onSend(text.trim(), pendingImages.length > 0 ? pendingImages : undefined)
    setText('')
    setPendingImages([])
    setAttachError(null)
    textareaRef.current?.focus()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const reason = disabled ? disabledReason : isRunning ? null : !canSend ? 'Type a task or attach an image to send.' : null

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
          if (!canAttach) return
          e.preventDefault()
          setDragActive(true)
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
      >
        {pendingImages.length > 0 && (
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
            {imagesEnabled && (
              <button
                className="ad-composer__attach"
                onClick={() => void handleAttachClick()}
                disabled={!canAttach || attaching}
                title="Attach images"
                type="button"
              >
                <Paperclip size={14} />
              </button>
            )}
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
