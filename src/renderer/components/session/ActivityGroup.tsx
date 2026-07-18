import type React from 'react'
import { useState } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import type { ActivityItem } from './activity'
import { summarizeActivityGroup } from './activity'
import { ActivityDetailCard } from './ActivityDetailCard'
import './ActivityGroup.css'

export function ActivityGroup({ items, workspaceId }: { items: ActivityItem[]; workspaceId: string | null }): React.JSX.Element {
  const hasError = items.some((i) => i.isError)
  // Failures are surfaced immediately, not hidden behind a collapsed
  // toggle — everything else starts collapsed to stay non-noisy.
  const [expanded, setExpanded] = useState(hasError)
  const running = items.some((i) => i.status === 'running')

  return (
    <div className={`ad-activity-group${hasError ? ' ad-activity-group--error' : ''}`}>
      <button className="ad-activity-group__summary" onClick={() => setExpanded((v) => !v)}>
        <ChevronRight size={13} className={`ad-activity-group__chevron${expanded ? ' ad-activity-group__chevron--open' : ''}`} />
        {running && <Loader2 size={12} className="ad-spin" />}
        <span>{summarizeActivityGroup(items)}</span>
      </button>
      {expanded && (
        <div className="ad-activity-group__detail">
          {items.map((item) => (
            <div key={item.id} className="ad-activity-item">
              <div className="ad-activity-item__tool">
                {item.tool || 'tool'}
                {item.status === 'running' && <span className="ad-activity-item__running">running…</span>}
                {item.isError && <span className="ad-activity-item__failed">failed</span>}
              </div>
              {item.richDetail ? (
                <ActivityDetailCard detail={item.richDetail} workspaceId={workspaceId} />
              ) : (
                <>
                  {item.input != null && <pre className="ad-activity-item__code">{safeStringify(item.input)}</pre>}
                  {item.detail && <pre className="ad-activity-item__code">{item.detail}</pre>}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
