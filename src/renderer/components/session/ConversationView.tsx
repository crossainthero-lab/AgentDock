import type React from 'react'
import { useEffect, useRef } from 'react'
import { MessageSquare } from 'lucide-react'
import type { SessionMessage } from '@shared/types'
import type { PendingInteraction } from '@shared/events/AgentEventReducer'
import { MessageBubble } from './MessageBubble'
import { ActivityGroup } from './ActivityGroup'
import { ActivityTicker } from './ActivityTicker'
import { InteractionCard } from './InteractionCard'
import type { ActivityItem } from './activity'
import { EmptyState } from '../ui/EmptyState'
import './ConversationView.css'

type TimelineItem =
  | { kind: 'message'; message: SessionMessage }
  | { kind: 'activity-group'; items: ActivityItem[] }
  | { kind: 'pending-text'; text: string }

function buildTimeline(messages: SessionMessage[], pendingText: string): TimelineItem[] {
  const timeline: TimelineItem[] = []
  let group: ActivityItem[] = []

  const flush = (): void => {
    if (group.length > 0) {
      timeline.push({ kind: 'activity-group', items: group })
      group = []
    }
  }

  for (const message of messages) {
    if (message.role === 'assistant' && message.content.kind === 'activity') {
      group.push({
        id: message.id,
        tool: message.content.tool,
        input: null,
        detail: message.content.detail,
        isError: message.content.isError,
        status: 'done'
      })
    } else {
      flush()
      timeline.push({ kind: 'message', message })
    }
  }
  flush()

  if (pendingText.trim()) {
    timeline.push({ kind: 'pending-text', text: pendingText })
  }

  return timeline
}

interface ConversationViewProps {
  messages: SessionMessage[]
  pendingText: string
  activityLabel: string | null
  pendingInteraction: PendingInteraction | null
  agentLabel: string
  onRespondInteraction: (interactionId: string, optionId: string) => void
  onOpenTerminal: () => void
}

export function ConversationView({
  messages,
  pendingText,
  activityLabel,
  pendingInteraction,
  agentLabel,
  onRespondInteraction,
  onOpenTerminal
}: ConversationViewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const timeline = buildTimeline(messages, pendingText)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [timeline.length, pendingText, activityLabel, pendingInteraction])

  if (timeline.length === 0 && !activityLabel && !pendingInteraction) {
    return (
      <div className="ad-conversation ad-conversation--empty">
        <EmptyState
          icon={<MessageSquare size={28} strokeWidth={1.5} />}
          title="Start a session to send a task"
          description={`Tell ${agentLabel} what you want done in this project.`}
        />
      </div>
    )
  }

  return (
    <div className="ad-conversation" ref={scrollRef}>
      <div className="ad-conversation__inner">
        {timeline.map((item, i) => {
          if (item.kind === 'activity-group') {
            return <ActivityGroup key={`group-${i}`} items={item.items} />
          }
          if (item.kind === 'pending-text') {
            return <MessageBubble key="pending" role="assistant" text={item.text} />
          }
          const { message } = item
          if (message.content.kind === 'text') {
            return <MessageBubble key={message.id} role={message.role} text={message.content.text} />
          }
          if (message.content.kind === 'interaction-record') {
            return (
              <div key={message.id} className="ad-conversation__interaction-note">
                {message.content.prompt} — <strong>{message.content.choiceLabel}</strong>
              </div>
            )
          }
          return null
        })}
        <ActivityTicker label={activityLabel} />
        {pendingInteraction && (
          <InteractionCard interaction={pendingInteraction} onRespond={onRespondInteraction} onOpenTerminal={onOpenTerminal} />
        )}
      </div>
    </div>
  )
}
