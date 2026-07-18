import type { ActivityDetail } from '@shared/events/agent-event'

export interface ActivityItem {
  id: string
  tool: string
  input: unknown
  detail: string | null
  isError: boolean
  status: 'running' | 'done'
  /** Structured, tool-specific payload for a rich card (real command
   *  output, changed file paths, ...) — see ActivityDetail. Absent for
   *  agents/tools that only report a plain label. */
  richDetail?: ActivityDetail
}

type Category = 'read' | 'write' | 'exec' | 'other'

function categorize(tool: string): Category {
  const t = tool.toLowerCase()
  if (t.includes('read') || t.includes('glob') || t.includes('grep') || t.includes('ls')) return 'read'
  if (t.includes('write') || t.includes('edit')) return 'write'
  if (t.includes('bash') || t.includes('exec') || t.includes('command') || t.includes('shell')) return 'exec'
  return 'other'
}

export function summarizeActivityGroup(items: ActivityItem[]): string {
  if (items.length === 1) {
    const item = items[0]
    return item.isError ? `${item.tool || 'A tool call'} failed` : describeOne(item)
  }

  const categories = new Set(items.map((i) => categorize(i.tool)))
  const errorCount = items.filter((i) => i.isError).length
  const n = items.length

  let base: string
  if (categories.size === 1) {
    const [only] = categories
    base = only === 'read' ? `Inspected ${n} files` : only === 'write' ? `Modified ${n} files` : only === 'exec' ? `Ran ${n} commands` : `Performed ${n} actions`
  } else {
    base = `Performed ${n} actions`
  }

  return errorCount > 0 ? `${base} (${errorCount} failed)` : base
}

function describeOne(item: ActivityItem): string {
  const category = categorize(item.tool)
  if (category === 'exec') return `Ran ${item.tool || 'a command'}`
  if (category === 'read') return `Read a file (${item.tool})`
  if (category === 'write') return `Modified a file (${item.tool})`
  return item.tool ? `Ran ${item.tool}` : 'Tool activity'
}
