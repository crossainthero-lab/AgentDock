import type React from 'react'
import { FileWarning } from 'lucide-react'
import type { FilePreview as FilePreviewResult } from '@shared/types'
import { CodeBlock } from '../markdown/CodeBlock'
import { languageForFileName } from './fileIcons'
import { Spinner } from '../ui/Spinner'

interface FilePreviewProps {
  relPath: string | null
  loading: boolean
  preview: FilePreviewResult | null
}

export function FilePreview({ relPath, loading, preview }: FilePreviewProps): React.JSX.Element {
  if (!relPath) {
    return (
      <div className="ad-file-preview ad-file-preview--empty">
        <span>Select a file to preview it.</span>
      </div>
    )
  }

  if (loading || !preview) {
    return (
      <div className="ad-file-preview ad-file-preview--empty">
        <Spinner size={16} />
      </div>
    )
  }

  const name = relPath.split('/').pop() ?? relPath

  if (preview.kind === 'image') {
    return (
      <div className="ad-file-preview">
        <div className="ad-file-preview__image-wrap">
          <img src={preview.dataUrl} alt={name} className="ad-file-preview__image" />
        </div>
      </div>
    )
  }

  if (preview.kind === 'text') {
    return (
      <div className="ad-file-preview ad-file-preview--text">
        <CodeBlock language={languageForFileName(name)} code={preview.content} />
        {preview.truncated && <div className="ad-file-preview__truncated">File truncated for preview — showing the first portion only.</div>}
      </div>
    )
  }

  const reason = preview.kind === 'unsupported' ? preview.reason : preview.error

  return (
    <div className="ad-file-preview ad-file-preview--empty">
      <FileWarning size={22} strokeWidth={1.5} />
      <span>{reason}</span>
    </div>
  )
}
