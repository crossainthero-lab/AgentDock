import type React from 'react'
import { Loader2 } from 'lucide-react'
import './ActivityTicker.css'

/** The live "Worked for 12s · Read 8 files · Edited 3 files" line — a single
 *  element that updates in place as new activity_started/activity_updated/
 *  activity_completed events arrive, instead of accumulating a growing
 *  list of status lines. */
export function ActivityTicker({ label }: { label: string | null }): React.JSX.Element | null {
  if (!label) return null
  return (
    <div className="ad-activity-ticker">
      <Loader2 size={12} className="ad-spin" />
      <span>{label}</span>
    </div>
  )
}
