import type React from 'react'
import { RefreshCw } from 'lucide-react'
import type { ProviderUsageSnapshot } from '@shared/types'
import { IconButton } from '../ui/IconButton'
import './ProviderUsageIndicator.css'

interface ProviderUsageIndicatorProps {
  usage: ProviderUsageSnapshot | null | undefined
  loading?: boolean
  compact?: boolean
  onRefresh?: () => void
}

function labelFor(usage: ProviderUsageSnapshot | null | undefined): string {
  if (!usage) return 'Usage unavailable'
  if (usage.limitReached) return usage.resetAt ? `Limit reached - resets ${new Date(usage.resetAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Limit reached'
  if (usage.usedPercent !== null) return `${usage.usedPercent}% used`
  if (usage.remainingPercent !== null) return `${usage.remainingPercent}% remaining`
  if (usage.status === 'available') return 'Available'
  if (usage.status === 'unsupported') return 'Exact usage unavailable'
  if (usage.status === 'error') return 'Usage check failed'
  return usage.message || 'Exact usage unavailable'
}

export function ProviderUsageIndicator({ usage, loading = false, compact = false, onRefresh }: ProviderUsageIndicatorProps): React.JSX.Element {
  const percent = usage?.usedPercent ?? (usage?.remainingPercent !== null && usage?.remainingPercent !== undefined ? 100 - usage.remainingPercent : null)
  const showDonut = percent !== null && usage?.quality === 'exact'
  const label = loading ? 'Checking usage...' : labelFor(usage)
  const tone = usage?.limitReached ? 'limit' : usage?.status === 'error' ? 'error' : usage?.status === 'available' ? 'ok' : 'neutral'

  return (
    <div className={`ad-usage ad-usage--${tone}${compact ? ' ad-usage--compact' : ''}`} title={usage?.message ?? label}>
      {showDonut && (
        <span className="ad-usage__donut" style={{ '--ad-usage-percent': `${percent}%` } as React.CSSProperties} aria-hidden />
      )}
      <span className="ad-usage__text">{label}</span>
      {onRefresh && (
        <IconButton label="Refresh usage" size="sm" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={12} className={loading ? 'ad-usage__spin' : undefined} />
        </IconButton>
      )}
    </div>
  )
}
