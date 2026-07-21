import type { AgentId, HandoffExecuteInput, HandoffExecuteResult, Session, SessionMessage } from '@shared/types'
import { sessionRepo } from '../db/repositories/session-repo'
import { messageRepo } from '../db/repositories/message-repo'
import { workspaceRepo } from '../db/repositories/workspace-repo'
import { sessionService } from './session-service'
import { deriveTitleFromPrompt, stripContinuedSuffix, withContinuedSuffix, UNTITLED_CONVERSATION } from './title-service'

const AGENT_LABEL: Record<AgentId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity'
}

// Payload-size protection (see this module's own doc comment below for the
// root cause these bound against). Generous enough for a genuinely busy
// conversation to still produce a useful summary, small enough that no
// single hop can meaningfully inflate a continuation chain.
const MAX_REQUESTS = 5
const MAX_FILES = 15
const MAX_ACTIONS = 12
const MAX_ISSUES = 5
const MAX_RESPONSE_CHARS = 600
const MAX_LINE_CHARS = 200
const MAX_SUMMARY_CHARS = 4000

export const handoffService = {
  /**
   * Builds a deterministic, mechanical summary from the session's real
   * message history — no model call is made on AgentDock's side. It's
   * intentionally editable in the HandoffDialog before being sent.
   *
   * CRITICAL (real bug fix — root cause of the reported Antigravity
   * continuation failure): a continued session's OWN message history always
   * contains, as its first user-role message, the mechanical handoff
   * envelope that created it (this same function's own output, from the
   * PREVIOUS hop). The original implementation scanned every user message
   * unconditionally ("Requests made so far"), so handing off a second time
   * (e.g. Claude -> Codex -> Antigravity) re-embedded the ENTIRE first
   * envelope — itself containing Claude's summary — inside Codex's own
   * summary, which then got embedded again for Antigravity: exponential,
   * recursive duplication of "Continuing a session started with...", full
   * action lists, and "Most recent response" blocks, several turns deep.
   * The resulting prompt was large and structurally malformed enough
   * (multi-KB, deeply repeated text passed as a single PTY argv value —
   * see AntigravityAdapter.ts's `-i` handling) that agy's own CLI showed
   * "Interrupted" instead of ever starting the task.
   *
   * Fixed structurally, not just by truncating harder: this function only
   * ever describes THIS session's own genuine content. If this session was
   * itself created via a continuation (`continuedFromSessionId` set), its
   * very first user message is — provably, by construction, since
   * `execute()` below always creates the session and immediately sends
   * this as turn 1 before anything else can happen — that injected
   * envelope, and it is excluded before any section is built. A chain of N
   * handoffs therefore produces O(1) summary size per hop, not O(N) or
   * worse, regardless of how deep the chain goes. A single provenance line
   * ("Continuing from a <Agent> conversation") replaces re-embedding the
   * ancestor's own summary text.
   *
   * CRITICAL (real bug fix — root cause of a reported malformed/noisy
   * handoff prompt): a real agentic session can retry the same failing
   * command several times (confirmed live: Codex re-running a near-
   * identical PowerShell check after an earlier one errored) — the old
   * implementation listed every activity verbatim, so a handful of retried
   * failures turned into a wall of near-duplicate "Bash failed" bullets
   * with no more information than the first one carried. Fixed by
   * collapsing consecutive/repeated activity entries that share the exact
   * same summary text into one bullet with a "(x N)" / "(failed N times)"
   * count (see collapseActivity below) — real, distinct actions are never
   * merged, only genuine literal repeats.
   *
   * Output is structured as exactly five sections, in order, matching the
   * required continuation format: (1) workspace, (2) a one-line
   * provenance/title note, (3) a brief "Prior work completed" summary
   * (requests + collapsed actions + the last real response — never raw
   * per-tool output), (4) files changed, (5) unresolved issues (collapsed
   * failures only). The CURRENT task itself is never part of this
   * summary — it's the caller's own `instruction`, prepended exactly once
   * by buildContinuationPrompt, never re-inserted here.
   */
  generateSummary(sessionId: string): string {
    const session = sessionRepo.get(sessionId)
    if (!session) throw new Error('Session not found.')
    const workspace = workspaceRepo.get(session.workspaceId)
    const allMessages = messageRepo.listBySession(sessionId)
    const messages = excludeHandoffEnvelope(allMessages, session.continuedFromSessionId !== null)

    const lines: string[] = []

    // (1) Workspace path.
    if (workspace) lines.push(`Workspace: ${workspace.path}`)
    // (2) Provenance — which agent/conversation this continues.
    lines.push(`Continuing from a ${AGENT_LABEL[session.agentId]} conversation ("${stripContinuedSuffix(session.title)}").`)

    // (3) Brief summary of prior completed work.
    const userAsks = messages.filter((m) => m.role === 'user' && m.content.kind === 'text')
    const activityMessages = messages.filter((m) => m.role === 'assistant' && m.content.kind === 'activity')
    const collapsedActivity = collapseActivity(activityMessages)
    const successfulActions = collapsedActivity.filter((a) => !a.isError)
    const failedActions = collapsedActivity.filter((a) => a.isError)
    const lastAssistantText = [...messages].reverse().find((m) => m.role === 'assistant' && m.content.kind === 'text' && m.content.text)

    const hasPriorWork = userAsks.length > 0 || successfulActions.length > 0 || !!lastAssistantText
    if (hasPriorWork) {
      lines.push('', 'Prior work completed:')
      for (const m of userAsks.slice(-MAX_REQUESTS)) {
        if (m.content.kind === 'text') lines.push(`- Requested: ${truncate(m.content.text, MAX_LINE_CHARS)}`)
      }
      if (userAsks.length > MAX_REQUESTS) lines.push(`- …and ${userAsks.length - MAX_REQUESTS} earlier request(s)`)
      for (const a of successfulActions.slice(0, MAX_ACTIONS)) {
        lines.push(`- ${truncate(a.label, MAX_LINE_CHARS)}${a.count > 1 ? ` (x${a.count})` : ''}`)
      }
      if (successfulActions.length > MAX_ACTIONS) lines.push(`- …and ${successfulActions.length - MAX_ACTIONS} more action(s)`)
      if (lastAssistantText?.content.kind === 'text') {
        lines.push(`- Result: ${truncate(lastAssistantText.content.text, MAX_RESPONSE_CHARS)}`)
      }
    }

    // (4) Relevant files changed.
    const files = extractChangedFiles(messages)
    if (files.length > 0) {
      const shown = files.slice(0, MAX_FILES).join(', ')
      const more = files.length > MAX_FILES ? `, +${files.length - MAX_FILES} more` : ''
      lines.push('', `Files changed: ${shown}${more}`)
    }

    // (5) Important unresolved issues — collapsed, never a raw failure dump.
    if (failedActions.length > 0) {
      lines.push('', 'Unresolved issues:')
      for (const a of failedActions.slice(0, MAX_ISSUES)) {
        lines.push(`- ${truncate(a.label, MAX_LINE_CHARS)}${a.count > 1 ? ` (failed ${a.count} times)` : ''}`)
      }
      if (failedActions.length > MAX_ISSUES) lines.push(`- …and ${failedActions.length - MAX_ISSUES} more issue(s)`)
    }

    return capPayload(lines.join('\n').trim(), MAX_SUMMARY_CHARS)
  },

  /**
   * CRITICAL (real bug fix — root cause of the reported "continued agent
   * response is blank" bug): this used to send the new session's first
   * prompt itself, right here, via `sessionService.sendPrompt(newSession.id,
   * prompt, randomUUID())` — inventing a turnId the renderer never learns.
   * Every AgentEvent is turn-scoped (AgentEventReducer.isForActiveTurn
   * requires `state.turn.id === event.turnId`), and `state.turn` is only
   * ever populated by the renderer's OWN beginSend(), called from
   * conversationStore.sendPrompt() right before the matching IPC call. A
   * turn this function started server-side, with a turnId of its own
   * invention, could therefore never have a matching local `turn` — so
   * `isForActiveTurn` rejected every single event for it (deltas, activity,
   * even the completion) as `stale_turn`, unconditionally, regardless of
   * timing. The reply was still correctly persisted by session-service
   * (messageRepo.add doesn't depend on the renderer at all), and the user's
   * own continuation prompt was too — but the assistant's response never
   * had anywhere to attach to live, and reseeding from the DB on the next
   * mount only helps once the turn has actually finished, which loses the
   * live streaming entirely and often loses the race against a still-in-
   * flight turn too.
   *
   * Fixed structurally: this only ever CREATES the session and returns the
   * constructed prompt text — never sends it. The caller (HandoffDialog)
   * sends that exact text as the new session's first ordinary message,
   * through conversationStore.sendPrompt(), the same turnId-owning path
   * every other prompt in the app already uses correctly.
   */
  async execute(input: HandoffExecuteInput, onSessionCreated?: (session: Session) => void): Promise<HandoffExecuteResult> {
    const source = sessionRepo.get(input.sourceSessionId)
    if (!source) throw new Error('Session not found.')

    const instruction = input.additionalInstruction.trim()
    const derivedTitle = instruction ? deriveTitleFromPrompt(instruction) : null
    const baseTitle = derivedTitle ?? (stripContinuedSuffix(source.title) || UNTITLED_CONVERSATION)
    const title = withContinuedSuffix(baseTitle)

    // Do not rename/mutate the source session — a fresh session row is the
    // only thing this ever creates or touches.
    const newSession = sessionService.create({
      workspaceId: source.workspaceId,
      agentId: input.destinationAgentId,
      title,
      titleSource: 'handoff',
      continuedFromSessionId: source.id
    })
    // Still useful even though this no longer sends anything itself — wires
    // main-process event forwarding (see ipc/session.ts's ensureForwarding)
    // before the renderer's own sendPrompt IPC call arrives, though that
    // call wires it too (idempotent either way).
    onSessionCreated?.(newSession)

    // Bounded again here, independent of generateSummary's own cap — the
    // summary field is user-editable in the dialog, so this is the real
    // backstop against a pasted-in oversized value, not just a formality.
    const boundedSummary = capPayload(input.summary.trim(), MAX_SUMMARY_CHARS)
    const prompt = buildContinuationPrompt(instruction, boundedSummary)

    return { session: newSession, prompt }
  }
}

/** The user's new instruction leads (it's the actual task), followed by the
 *  grounding context — placed once, never duplicated, never re-wrapped in
 *  another "Additional instruction:" layer the way the previous
 *  implementation did. */
function buildContinuationPrompt(instruction: string, summary: string): string {
  const lead = instruction || 'Continue the work described below.'
  return `${lead}\n\n--- Continuation context ---\n${summary}`
}

/** Excludes exactly the chronologically-first user message when this
 *  session is itself a continuation — see generateSummary's doc comment for
 *  why that's always and only the injected handoff envelope, never a
 *  genuine user request, for a session created this way. */
function excludeHandoffEnvelope(messages: SessionMessage[], isContinuation: boolean): SessionMessage[] {
  if (!isContinuation) return messages
  const envelopeIndex = messages.findIndex((m) => m.role === 'user')
  if (envelopeIndex === -1) return messages
  return messages.filter((_, i) => i !== envelopeIndex)
}

interface CollapsedActivity {
  /** The first occurrence's own summary text — never rewritten/merged
   *  across entries, so a genuinely distinct action (different summary
   *  text) always gets its own bullet. */
  label: string
  /** How many activity messages shared this exact (isError, summary) pair,
   *  in original order — 1 for anything that only happened once. */
  count: number
  isError: boolean
}

/** Collapses activity messages that share the exact same (isError, summary)
 *  pair into one entry with a repeat count, preserving first-seen order —
 *  this is what stops a retried failing command (or any other literally
 *  repeated action) from producing a wall of near-identical bullets in the
 *  handoff summary. Only an EXACT text match collapses; two genuinely
 *  different commands/results always stay as separate entries. */
function collapseActivity(messages: SessionMessage[]): CollapsedActivity[] {
  const order: string[] = []
  const byKey = new Map<string, CollapsedActivity>()
  for (const m of messages) {
    if (m.content.kind !== 'activity') continue
    const key = `${m.content.isError ? '1' : '0'}:${m.content.summary}`
    const existing = byKey.get(key)
    if (existing) {
      existing.count += 1
    } else {
      byKey.set(key, { label: m.content.summary, count: 1, isError: m.content.isError })
      order.push(key)
    }
  }
  return order.map((key) => byKey.get(key) as CollapsedActivity)
}

const FILE_IN_PARENS = /\(([^()]*\.[a-zA-Z0-9]{1,10})\)/g

/** Real file paths only — never invented. Prefers the structured
 *  `file_change` detail Codex populates; falls back to a conservative regex
 *  over the activity's own label text (matches shapes actually observed
 *  live, e.g. Antigravity's "Create(C:/path/file.py)" and a generic
 *  "Edit(src/foo.ts)") for agents that only report a plain label. */
function extractChangedFiles(messages: SessionMessage[]): string[] {
  const seen = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'assistant' || m.content.kind !== 'activity') continue
    const detail = m.content.richDetail
    if (detail?.kind === 'file_change') {
      for (const change of detail.changes) seen.add(change.path)
      continue
    }
    const text = `${m.content.detail} ${m.content.summary}`
    for (const match of text.matchAll(FILE_IN_PARENS)) {
      seen.add(match[1])
    }
  }
  return [...seen]
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

function capPayload(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…(truncated, ${text.length - max} more characters omitted)`
}
