import { randomUUID } from 'node:crypto'
import type { AgentId, HandoffExecuteInput, Session, SessionMessage } from '@shared/types'
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
const MAX_REQUEST_CHARS = 200
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
   */
  generateSummary(sessionId: string): string {
    const session = sessionRepo.get(sessionId)
    if (!session) throw new Error('Session not found.')
    const workspace = workspaceRepo.get(session.workspaceId)
    const allMessages = messageRepo.listBySession(sessionId)
    const messages = excludeHandoffEnvelope(allMessages, session.continuedFromSessionId !== null)

    const lines: string[] = []

    if (workspace) lines.push(`Workspace: ${workspace.path}`)
    lines.push(`Continuing from a ${AGENT_LABEL[session.agentId]} conversation ("${stripContinuedSuffix(session.title)}").`)

    const userAsks = messages.filter((m) => m.role === 'user' && m.content.kind === 'text')
    if (userAsks.length > 0) {
      lines.push('', 'Requests in this conversation:')
      for (const m of userAsks.slice(-MAX_REQUESTS)) {
        if (m.content.kind === 'text') lines.push(`- ${truncate(m.content.text, MAX_REQUEST_CHARS)}`)
      }
      if (userAsks.length > MAX_REQUESTS) lines.push(`- …and ${userAsks.length - MAX_REQUESTS} earlier request(s)`)
    }

    const files = extractChangedFiles(messages)
    if (files.length > 0) {
      const shown = files.slice(0, MAX_FILES).join(', ')
      const more = files.length > MAX_FILES ? `, +${files.length - MAX_FILES} more` : ''
      lines.push('', `Files changed: ${shown}${more}`)
    }

    const activity = messages.filter((m) => m.role === 'assistant' && m.content.kind === 'activity')
    if (activity.length > 0) {
      lines.push('', `Actions taken (${activity.length} total):`)
      for (const m of activity.slice(0, MAX_ACTIONS)) {
        if (m.content.kind === 'activity') lines.push(`- ${m.content.summary}`)
      }
      if (activity.length > MAX_ACTIONS) lines.push(`- …and ${activity.length - MAX_ACTIONS} more`)
    }

    const issues = activity.filter((m) => m.content.kind === 'activity' && m.content.isError)
    if (issues.length > 0) {
      lines.push('', 'Issues encountered:')
      for (const m of issues.slice(0, MAX_ISSUES)) {
        if (m.content.kind === 'activity') lines.push(`- ${m.content.summary}`)
      }
    }

    const lastAssistantText = [...messages].reverse().find((m) => m.role === 'assistant' && m.content.kind === 'text' && m.content.text)
    if (lastAssistantText?.content.kind === 'text') {
      lines.push('', 'Most recent response:', truncate(lastAssistantText.content.text, MAX_RESPONSE_CHARS))
    }

    return capPayload(lines.join('\n').trim(), MAX_SUMMARY_CHARS)
  },

  async execute(input: HandoffExecuteInput, onSessionCreated?: (session: Session) => void): Promise<Session> {
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
    // Give the caller a chance to wire event forwarding before sendPrompt
    // starts emitting — otherwise the first few events could fire before
    // any renderer subscription exists.
    onSessionCreated?.(newSession)

    // Bounded again here, independent of generateSummary's own cap — the
    // summary field is user-editable in the dialog, so this is the real
    // backstop against a pasted-in oversized value, not just a formality.
    const boundedSummary = capPayload(input.summary.trim(), MAX_SUMMARY_CHARS)
    const prompt = buildContinuationPrompt(instruction, boundedSummary)

    await sessionService.sendPrompt(newSession.id, prompt, randomUUID())
    return newSession
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
