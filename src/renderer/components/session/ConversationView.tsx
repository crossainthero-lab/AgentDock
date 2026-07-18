import type React from 'react'
import { useEffect, useRef } from 'react'
import { MessageSquare } from 'lucide-react'
import type { ChatItem } from '@shared/events/AgentEventReducer'
import type { PendingInteraction } from '@shared/events/AgentEventReducer'
import { MessageBubble } from './MessageBubble'
import { ActivityGroup } from './ActivityGroup'
import { ActivityTicker } from './ActivityTicker'
import { InteractionCard } from './InteractionCard'
import type { ActivityItem } from './activity'
import { EmptyState } from '../ui/EmptyState'
import './ConversationView.css'

type TimelineEntry = { kind: 'item'; item: ChatItem } | { kind: 'activity-group'; items: ActivityItem[] }

/** One ordered list, sourced entirely from the session store's `items` — no
 *  second, disjoint "pending text" render path exists anymore (that used to
 *  duplicate the just-persisted assistant reply; see AgentEventReducer.ts). */
function buildTimeline(items: ChatItem[]): TimelineEntry[] {
  const timeline: TimelineEntry[] = []
  let group: ActivityItem[] = []

  const flush = (): void => {
    if (group.length > 0) {
      timeline.push({ kind: 'activity-group', items: group })
      group = []
    }
  }

  for (const item of items) {
    if (item.kind === 'tool-activity') {
      group.push({ id: item.id, tool: item.tool, input: null, detail: item.detail, isError: item.isError, status: 'done', richDetail: item.richDetail })
    } else {
      flush()
      timeline.push({ kind: 'item', item })
    }
  }
  flush()

  return timeline
}

interface ConversationViewProps {
  items: ChatItem[]
  activityLabel: string | null
  pendingInteraction: PendingInteraction | null
  agentLabel: string
  onRespondInteraction: (interactionId: string, optionId: string) => void
  onRetryMessage: (userMessageId: string) => void
  onOpenTerminal: () => void
  /** Needed to resolve local image/link paths in assistant Markdown — null
   *  when there's no open workspace. */
  workspaceId: string | null
}

export function ConversationView({
  items,
  activityLabel,
  pendingInteraction,
  agentLabel,
  onRespondInteraction,
  onRetryMessage,
  onOpenTerminal,
  workspaceId
}: ConversationViewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const timeline = buildTimeline(items)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [timeline.length, activityLabel, pendingInteraction])

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
        {timeline.map((entry, i) => {
          if (entry.kind === 'activity-group') {
            return <ActivityGroup key={`group-${i}`} items={entry.items} workspaceId={workspaceId} />
          }
          const { item } = entry
          if (item.kind === 'user') {
            return (
              <MessageBubble
                key={item.id}
                role="user"
                text={item.text}
                deliveryState={item.deliveryState}
                onRetry={item.deliveryState === 'failed' ? () => onRetryMessage(item.id) : undefined}
              />
            )
          }
          if (item.kind === 'assistant') {
            return <MessageBubble key={item.id} role="assistant" text={item.text} workspaceId={workspaceId} />
          }
          if (item.kind === 'system') {
            return <MessageBubble key={item.id} role={item.role} text={item.text} />
          }
          if (item.kind === 'interaction-record') {
            return (
              <div key={item.id} className="ad-conversation__interaction-note">
                {item.prompt} — <strong>{item.choiceLabel}</strong>
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
