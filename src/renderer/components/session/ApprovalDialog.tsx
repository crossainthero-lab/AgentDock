import type React from 'react'
import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { getAgentDock } from '../../lib/agentDockClient'
import type { ApprovalDecision, ApprovalRequest } from '@shared/types'
import { AGENT_DISPLAY_NAMES } from '@shared/types'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'
import './ApprovalDialog.css'

/**
 * Mounted once, globally. Only ever shows when a real `approval-request`
 * event arrives from an adapter — with the current adapters (see their
 * source comments on interactive-permission limitations) that will rarely
 * or never happen, but the dialog is fully wired so it activates correctly
 * the moment one does fire. No approval request is ever fabricated here.
 */
export function ApprovalDialog(): React.JSX.Element | null {
  const [request, setRequest] = useState<ApprovalRequest | null>(null)

  useEffect(() => {
    return getAgentDock().approvals.onRequest((incoming) => setRequest(incoming))
  }, [])

  if (!request) return null

  async function respond(decision: ApprovalDecision): Promise<void> {
    await getAgentDock().approvals.respond(request!.id, decision)
    setRequest(null)
  }

  return (
    <Dialog
      open
      onClose={() => void respond('deny')}
      title="Approval requested"
      width={460}
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="danger" onClick={() => void respond('deny')}>
            Deny
          </Button>
          <Button variant="secondary" onClick={() => void respond('allow-once')}>
            Allow Once
          </Button>
          <Button variant="primary" onClick={() => void respond('allow-session')}>
            Allow for Session
          </Button>
        </>
      }
    >
      <div className="ad-approval">
        <div className="ad-approval__row">
          <span className="ad-approval__label">Agent</span>
          <span>{AGENT_DISPLAY_NAMES[request.agentId]}</span>
        </div>
        <div className="ad-approval__row">
          <span className="ad-approval__label">Risk</span>
          <Badge tone={request.riskLevel === 'high' ? 'danger' : request.riskLevel === 'medium' ? 'warning' : 'neutral'}>
            {request.riskLevel === 'high' && <AlertTriangle size={11} />} {request.riskLevel}
          </Badge>
        </div>
        <div className="ad-approval__row">
          <span className="ad-approval__label">Working directory</span>
          <span className="ad-approval__mono">{request.cwd}</span>
        </div>
        <div className="ad-approval__command">
          <span className="ad-approval__label">Proposed command</span>
          <pre>{request.command}</pre>
        </div>
        {request.explanation && <p className="ad-approval__explanation">{request.explanation}</p>}
      </div>
    </Dialog>
  )
}
