import type React from 'react'
import { useEffect, useState } from 'react'
import { getAgentDock } from '../../lib/agentDockClient'
import { useAppState } from '../../state/AppStateContext'
import { AGENT_DISPLAY_NAMES, AGENT_IDS, type AgentId, type Session } from '@shared/types'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import './HandoffDialog.css'

interface HandoffDialogProps {
  open: boolean
  onClose: () => void
  sourceSession: Session
  onCompleted: (newSession: Session) => void
}

export function HandoffDialog({ open, onClose, sourceSession, onCompleted }: HandoffDialogProps): React.JSX.Element | null {
  const { agents, refreshSessions } = useAppState()
  const [destination, setDestination] = useState<AgentId>(
    AGENT_IDS.find((id) => id !== sourceSession.agentId) ?? sourceSession.agentId
  )
  const [summary, setSummary] = useState('')
  const [instruction, setInstruction] = useState('')
  const [loadingSummary, setLoadingSummary] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoadingSummary(true)
    void getAgentDock()
      .handoff.generateSummary(sourceSession.id)
      .then(setSummary)
      .finally(() => setLoadingSummary(false))
  }, [open, sourceSession.id])

  if (!open) return null

  const destinationInstalled = agents.find((a) => a.agentId === destination)?.installed ?? false

  async function submit(): Promise<void> {
    setSubmitting(true)
    try {
      const session = await getAgentDock().handoff.execute({
        sourceSessionId: sourceSession.id,
        destinationAgentId: destination,
        summary,
        additionalInstruction: instruction
      })
      await refreshSessions()
      onCompleted(session)
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Continue with another agent"
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={submitting || loadingSummary || !destinationInstalled}>
            {submitting ? <Spinner size={13} /> : 'Continue'}
          </Button>
        </>
      }
    >
      <div className="ad-handoff">
        <label className="ad-handoff__field">
          <span>Destination agent</span>
          <select value={destination} onChange={(e) => setDestination(e.target.value as AgentId)}>
            {AGENT_IDS.map((id) => (
              <option key={id} value={id}>
                {AGENT_DISPLAY_NAMES[id]}
                {!agents.find((a) => a.agentId === id)?.installed ? ' (not installed)' : ''}
              </option>
            ))}
          </select>
        </label>
        {!destinationInstalled && <div className="ad-handoff__warning">{AGENT_DISPLAY_NAMES[destination]} is not installed.</div>}

        <label className="ad-handoff__field">
          <span>Handoff summary</span>
          {loadingSummary ? (
            <div className="ad-handoff__summary-loading">
              <Spinner size={14} /> Building summary…
            </div>
          ) : (
            <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={8} />
          )}
        </label>

        <label className="ad-handoff__field">
          <span>Additional instruction (optional)</span>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={2}
            placeholder="Anything specific for the new session to focus on…"
          />
        </label>
      </div>
    </Dialog>
  )
}
