import type React from 'react'
import { File, X } from 'lucide-react'
import { formatBytes } from '../explorer/fileIcons'
import './FileAttachmentChip.css'

interface FileAttachmentChipProps {
  fileName: string
  size: number | null
  onRemove: () => void
}

/** A pending non-image attachment in the composer — the file has already
 *  been copied into the project's attachments folder (see
 *  PromptComposer.tsx's attachFileFromPath/attachFileFromBlob); this just
 *  shows what's queued to send, unlike AttachmentThumbnail which renders an
 *  actual image preview. */
export function FileAttachmentChip({ fileName, size, onRemove }: FileAttachmentChipProps): React.JSX.Element {
  return (
    <div className="ad-file-chip" title={fileName}>
      <File size={13} className="ad-file-chip__icon" />
      <span className="ad-file-chip__name">{fileName}</span>
      {size != null && <span className="ad-file-chip__size">{formatBytes(size)}</span>}
      <button type="button" className="ad-file-chip__remove" onClick={onRemove} aria-label={`Remove ${fileName}`}>
        <X size={11} />
      </button>
    </div>
  )
}
