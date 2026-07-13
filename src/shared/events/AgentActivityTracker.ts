// Aggregates `activity`/`tool_activity` events into one summary that updates
// in place (e.g. "Worked for 12s · Read 8 files · Edited 3 files") instead of
// accumulating a growing list of lines. Pure and side-effect free so it can
// be driven by both the live event stream and unit tests directly.
import type { AgentEvent } from './agent-event'

export interface ActivityCounts {
  read: number
  edit: number
  exec: number
  other: number
}

export interface ActivityState {
  active: boolean
  startedAt: number | null
  reportedElapsedMs: number | null
  label: string | null
  counts: ActivityCounts
  errorCount: number
}

export function createActivityState(): ActivityState {
  return {
    active: false,
    startedAt: null,
    reportedElapsedMs: null,
    label: null,
    counts: { read: 0, edit: 0, exec: 0, other: 0 },
    errorCount: 0
  }
}

const READ_PATTERN = /^(Read|Glob|Grep|Search|List|WebFetch|WebSearch)\b/i
const EDIT_PATTERN = /^(Write|Edit|NotebookEdit|Apply|Patch)\b/i
const EXEC_PATTERN = /^(Bash|Exec|Shell|Run|Command)\b/i

export function categorizeToolLabel(label: string): keyof ActivityCounts {
  if (READ_PATTERN.test(label)) return 'read'
  if (EDIT_PATTERN.test(label)) return 'edit'
  if (EXEC_PATTERN.test(label)) return 'exec'
  return 'other'
}

/** Reset for the start of a new turn — called locally by the renderer the
 *  moment a prompt/command is submitted, since nothing in the wire protocol
 *  marks "a new turn began" (see AgentEventReducer). */
export function resetActivity(): ActivityState {
  return createActivityState()
}

export function applyActivityEvent(state: ActivityState, event: AgentEvent, now: number = Date.now()): ActivityState {
  switch (event.type) {
    case 'activity': {
      return {
        ...state,
        active: true,
        startedAt: state.startedAt ?? now,
        reportedElapsedMs: event.elapsedMs ?? state.reportedElapsedMs,
        label: event.label
      }
    }
    case 'tool_activity': {
      if (event.status === 'running') {
        return { ...state, active: true, startedAt: state.startedAt ?? now, label: event.label }
      }
      const category = categorizeToolLabel(event.label)
      return {
        ...state,
        active: true,
        startedAt: state.startedAt ?? now,
        label: event.label,
        counts: { ...state.counts, [category]: state.counts[category] + 1 },
        errorCount: state.errorCount + (event.status === 'error' ? 1 : 0)
      }
    }
    default:
      return state
  }
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** Renders the current activity as one line, e.g.
 *  "Worked for 12s · Read 8 files · Edited 3 files (1 failed)". Returns null
 *  when there's nothing to show. */
export function summarizeActivity(state: ActivityState, now: number = Date.now()): string | null {
  if (!state.active) return null
  const elapsedMs = state.reportedElapsedMs ?? (state.startedAt != null ? now - state.startedAt : 0)
  const seconds = Math.max(0, Math.round(elapsedMs / 1000))
  const parts = [`Worked for ${seconds}s`]
  if (state.counts.read) parts.push(`Read ${pluralize(state.counts.read, 'file')}`)
  if (state.counts.edit) parts.push(`Edited ${pluralize(state.counts.edit, 'file')}`)
  if (state.counts.exec) parts.push(`Ran ${pluralize(state.counts.exec, 'command')}`)
  if (state.counts.other) parts.push(pluralize(state.counts.other, 'action'))
  if (state.errorCount) parts.push(`${state.errorCount} failed`)
  return parts.join(' · ')
}
