import type React from 'react'
import { useEffect, useState } from 'react'
import { getAgentDock } from '../../lib/agentDockClient'
import { useAppState } from '../../state/AppStateContext'
import { AGENT_DISPLAY_NAMES, AGENT_IDS, type AgentId, type Session } from '@shared/types'
import { sendPrompt as sendConversationPrompt } from '../../state/conversationStore'
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
      const { session, prompt } = await getAgentDock().handoff.execute({
        sourceSessionId: sourceSession.id,
        destinationAgentId: destination,
        summary,
        additionalInstruction: instruction
      })
      // CRITICAL (real bug fix — see handoff-service.ts's module comment):
      // the new session's first prompt is sent HERE, through the exact same
      // turnId-owning path (conversationStore.sendPrompt) every other
      // message in the app uses — never auto-sent server-side, which used
      // to invent a turnId the renderer's reducer never learned and so
      // rejected every event for it, rendering the response blank.
      //
      // CRITICAL (real bug fix — root cause of the reported "handoff
      // context is visible in the user bubble" bug, confirmed via a real
      // captured Claude -> Codex -> Antigravity chain): `prompt` is the
      // FULL text actually delivered to the destination agent — the user's
      // instruction followed by the entire "--- Continuation context ---"
      // envelope (workspace path, prior actions, files changed, unresolved
      // issues; see handoff-service.ts's buildContinuationPrompt). That
      // full text must keep reaching the agent unchanged, but the chat
      // bubble the user sees must show only what they actually typed here.
      // `displayText` carries that distinction through sendPrompt (and from
      // there into the persisted message row — see session-service.ts) so
      // the clean bubble survives a session switch and an app restart, not
      // just this optimistic render. Mirrors buildContinuationPrompt's own
      // fallback wording exactly, so an empty "Additional instruction"
      // shows the same placeholder the destination agent itself received
      // as its lead line, not a blank bubble.
      const displayText = instruction.trim() || 'Continue the work described below.'
      void sendConversationPrompt(session.id, session.agentId, prompt, undefined, displayText)
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
          <select className="ad-select" value={destination} onChange={(e) => setDestination(e.target.value as AgentId)}>
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
