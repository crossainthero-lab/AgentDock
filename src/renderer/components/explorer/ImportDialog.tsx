import type React from 'react'
import { useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { getAgentDock } from '../../lib/agentDockClient'
import type { ImportFileResult } from '@shared/types'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import './ImportDialog.css'

type Resolution = 'rename' | 'replace' | 'skip'

interface ImportDialogProps {
  open: boolean
  onClose: () => void
  workspaceId: string
  sourcePaths: string[]
  defaultDestRelPath: string
  onImported: (results: ImportFileResult[], destRelPath: string) => void
}

function baseName(p: string): string {
  return p.split(/[/\\]/).pop() ?? p
}

function splitExt(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' }
}

async function resolveUniqueName(workspaceId: string, destRelPath: string, name: string, alreadyUsed: Set<string>): Promise<string> {
  const { stem, ext } = splitExt(name)
  let candidate = name
  let n = 1
  const maxAttempts = 500
  while (n <= maxAttempts) {
    if (!alreadyUsed.has(candidate)) {
      const conflicts = await getAgentDock().filesystem.checkImportConflicts(workspaceId, destRelPath, [candidate])
      if (conflicts.length === 0) break
    }
    candidate = `${stem} (${n})${ext}`
    n += 1
  }
  alreadyUsed.add(candidate)
  return candidate
}

/** Import flow: pick a destination folder, check for filename collisions,
 *  resolve each one (rename/replace/skip) rather than ever silently
 *  overwriting, then copy and show the resulting workspace-relative paths
 *  so the user can hand them to an agent in chat. */
export function ImportDialog({ open, onClose, workspaceId, sourcePaths, defaultDestRelPath, onImported }: ImportDialogProps): React.JSX.Element {
  const [destRelPath, setDestRelPath] = useState(defaultDestRelPath)
  const [step, setStep] = useState<'form' | 'resolve' | 'results'>('form')
  const [conflicts, setConflicts] = useState<string[]>([])
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({})
  const [results, setResults] = useState<ImportFileResult[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reset(): void {
    setStep('form')
    setConflicts([])
    setResolutions({})
    setResults([])
    setError(null)
  }

  async function checkAndProceed(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const fileNames = sourcePaths.map(baseName)
      const found = await getAgentDock().filesystem.checkImportConflicts(workspaceId, destRelPath, fileNames)
      if (found.length === 0) {
        await runImport(sourcePaths.map((sourcePath, i) => ({ sourcePath, targetName: fileNames[i] })))
        return
      }
      setConflicts(found)
      setResolutions(Object.fromEntries(found.map((name) => [name, 'rename' as Resolution])))
      setStep('resolve')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to check for existing files.')
    } finally {
      setBusy(false)
    }
  }

  async function runImport(files: { sourcePath: string; targetName: string }[]): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const imported = await getAgentDock().filesystem.importFiles(workspaceId, destRelPath, files)
      setResults(imported)
      setStep('results')
      onImported(imported, destRelPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import files.')
    } finally {
      setBusy(false)
    }
  }

  async function confirmResolutions(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const used = new Set<string>()
      const files: { sourcePath: string; targetName: string }[] = []
      for (const sourcePath of sourcePaths) {
        const name = baseName(sourcePath)
        const resolution = resolutions[name]
        if (resolution === 'skip') continue
        if (resolution === 'rename') {
          const targetName = await resolveUniqueName(workspaceId, destRelPath, name, used)
          files.push({ sourcePath, targetName })
        } else {
          files.push({ sourcePath, targetName: name })
        }
      }
      if (files.length === 0) {
        setResults([])
        setStep('results')
        onImported([], destRelPath)
        return
      }
      await runImport(files)
    } finally {
      setBusy(false)
    }
  }

  function handleClose(): void {
    reset()
    onClose()
  }

  return (
    <Dialog open={open} onClose={handleClose} title="Import files" width={520} closeOnBackdrop={!busy}>
      {step === 'form' && (
        <div className="ad-import-dialog">
          <div className="ad-import-dialog__label">Files to import</div>
          <ul className="ad-import-dialog__file-list">
            {sourcePaths.map((p) => (
              <li key={p}>{baseName(p)}</li>
            ))}
          </ul>
          <label className="ad-import-dialog__label" htmlFor="ad-import-dest">
            Destination folder
          </label>
          <input
            id="ad-import-dest"
            className="ad-import-dialog__input"
            value={destRelPath}
            onChange={(e) => setDestRelPath(e.target.value.replace(/^\/+/, ''))}
            placeholder="Leave blank for the project root"
            spellCheck={false}
          />
          <div className="ad-import-dialog__hint">Path is relative to the project root, e.g. "assets" or "docs/notes".</div>
          {error && <div className="ad-import-dialog__error">{error}</div>}
          <div className="ad-import-dialog__actions">
            <Button variant="secondary" onClick={handleClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void checkAndProceed()} disabled={busy || sourcePaths.length === 0}>
              Continue
            </Button>
          </div>
        </div>
      )}

      {step === 'resolve' && (
        <div className="ad-import-dialog">
          <div className="ad-import-dialog__label">
            {conflicts.length} file{conflicts.length === 1 ? '' : 's'} already exist in the destination
          </div>
          <ul className="ad-import-dialog__conflict-list">
            {conflicts.map((name) => (
              <li key={name} className="ad-import-dialog__conflict-row">
                <span className="ad-import-dialog__conflict-name">{name}</span>
                <div className="ad-import-dialog__conflict-choices">
                  {(['rename', 'replace', 'skip'] as Resolution[]).map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      className={`ad-import-dialog__choice${resolutions[name] === choice ? ' ad-import-dialog__choice--active' : ''}`}
                      onClick={() => setResolutions((prev) => ({ ...prev, [name]: choice }))}
                    >
                      {choice === 'rename' ? 'Rename' : choice === 'replace' ? 'Replace' : 'Skip'}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          {error && <div className="ad-import-dialog__error">{error}</div>}
          <div className="ad-import-dialog__actions">
            <Button variant="secondary" onClick={handleClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void confirmResolutions()} disabled={busy}>
              Import
            </Button>
          </div>
        </div>
      )}

      {step === 'results' && (
        <div className="ad-import-dialog">
          <div className="ad-import-dialog__label">Import complete</div>
          <ul className="ad-import-dialog__result-list">
            {results.map((r) => (
              <li key={r.sourceName} className="ad-import-dialog__result-row">
                {r.relPath ? (
                  <>
                    <CheckCircle2 size={14} className="ad-import-dialog__result-ok" />
                    <code>{r.relPath}</code>
                  </>
                ) : (
                  <>
                    <XCircle size={14} className="ad-import-dialog__result-err" />
                    <span>
                      {r.sourceName}: {r.error}
                    </span>
                  </>
                )}
              </li>
            ))}
            {results.length === 0 && <li>No files were imported.</li>}
          </ul>
          <div className="ad-import-dialog__actions">
            <Button variant="primary" onClick={handleClose}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
