import type React from 'react'
import { useEffect, useState } from 'react'
import { AlertTriangle, KeyRound, ShieldQuestion, Terminal as TerminalIcon } from 'lucide-react'
import type { PendingInteraction } from '@shared/events/AgentEventReducer'
import { Button } from '../ui/Button'
import './InteractionCard.css'

interface InteractionCardProps {
  interaction: PendingInteraction
  onRespond: (interactionId: string, optionId: string) => void
  onOpenTerminal: () => void
}

function isNegativeOption(label: string): boolean {
  return /^(no|n|deny|cancel|skip)\b/i.test(label.trim())
}

/** Renders a native control for a translated terminal interaction — the
 *  detected prompt plus real buttons wired to the same live PTY session, or
 *  the fallback card when AgentDock couldn't safely translate it. */
export function InteractionCard({ interaction, onRespond, onOpenTerminal }: InteractionCardProps): React.JSX.Element {
  // Belt-and-suspenders against a double-click or double-fire re-sending the
  // answer twice into the live PTY — the authoritative guard lives in
  // sessionService.respondToInteraction, this just stops the second click
  // from ever reaching it while this same card is still visible mid-transition.
  const [answered, setAnswered] = useState(false)
  useEffect(() => setAnswered(false), [interaction])

  function respondOnce(interactionId: string, optionId: string): void {
    if (answered) return
    setAnswered(true)
    onRespond(interactionId, optionId)
  }

  if (interaction.kind === 'terminal_attention') {
    return (
      <div className="ad-interaction-card ad-interaction-card--attention">
        <div className="ad-interaction-card__header">
          <TerminalIcon size={14} />
          <span>This agent needs direct terminal input.</span>
        </div>
        <p className="ad-interaction-card__detail">AgentDock could not safely translate this interaction.</p>
        <div className="ad-interaction-card__actions">
          <Button variant="primary" size="sm" onClick={onOpenTerminal}>
            Open terminal
          </Button>
        </div>
      </div>
    )
  }

  if (interaction.kind === 'authentication') {
    return (
      <div className="ad-interaction-card ad-interaction-card--attention">
        <div className="ad-interaction-card__header">
          <KeyRound size={14} />
          <span>Authentication required</span>
        </div>
        <p className="ad-interaction-card__detail">{interaction.message}</p>
        <div className="ad-interaction-card__actions">
          <Button variant="primary" size="sm" onClick={onOpenTerminal}>
            Open terminal
          </Button>
        </div>
      </div>
    )
  }

  const Icon = interaction.kind === 'permission' ? ShieldQuestion : AlertTriangle

  // No predefined options — this prompt couldn't be translated into a set
  // of choices (e.g. Claude is genuinely asking for typed input rather than
  // picking from a list). Fall back to a plain text field instead of
  // silently hiding the request or leaving it unanswerable.
  if (interaction.options.length === 0) {
    return (
      <div className="ad-interaction-card">
        <div className="ad-interaction-card__header">
          <Icon size={14} />
          <span>{interaction.prompt}</span>
        </div>
        <FreeTextResponse interactionId={interaction.interactionId} answered={answered} onSubmit={respondOnce} />
        <div className="ad-interaction-card__actions">
          <Button variant="ghost" size="sm" onClick={onOpenTerminal}>
            Open terminal
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="ad-interaction-card">
      <div className="ad-interaction-card__header">
        <Icon size={14} />
        <span>{interaction.prompt}</span>
      </div>
      <div className="ad-interaction-card__actions">
        {interaction.options.map((option) => (
          <Button
            key={option.id}
            variant={isNegativeOption(option.label) ? 'secondary' : 'primary'}
            size="sm"
            title={option.description}
            disabled={answered}
            onClick={() => respondOnce(interaction.interactionId, option.id)}
          >
            {option.label}
          </Button>
        ))}
        <Button variant="ghost" size="sm" onClick={onOpenTerminal}>
          Open terminal
        </Button>
      </div>
    </div>
  )
}

function FreeTextResponse({
  interactionId,
  answered,
  onSubmit
}: {
  interactionId: string
  answered: boolean
  onSubmit: (interactionId: string, text: string) => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  return (
    <form
      className="ad-interaction-card__freetext"
      onSubmit={(e) => {
        e.preventDefault()
        if (value.trim()) onSubmit(interactionId, value.trim())
      }}
    >
      <input
        type="text"
        value={value}
        disabled={answered}
        autoFocus
        placeholder="Type your response…"
        onChange={(e) => setValue(e.target.value)}
      />
      <Button type="submit" variant="primary" size="sm" disabled={answered || !value.trim()}>
        Send
      </Button>
    </form>
  )
}
