import type { AgentId, HandoffExecuteInput, Session } from '@shared/types'
import { sessionRepo } from '../db/repositories/session-repo'
import { messageRepo } from '../db/repositories/message-repo'
import { sessionService } from './session-service'

const AGENT_LABEL: Record<AgentId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity'
}

export const handoffService = {
  /**
   * Builds a deterministic, mechanical summary from the session's real
   * message history — no model call is made on AgentDock's side. It's
   * intentionally editable in the HandoffDialog before being sent.
   */
  generateSummary(sessionId: string): string {
    const session = sessionRepo.get(sessionId)
    if (!session) throw new Error('Session not found.')
    const messages = messageRepo.listBySession(sessionId)

    const lines: string[] = [
      `Continuing a session started with ${AGENT_LABEL[session.agentId]} ("${session.title}").`,
      ''
    ]

    const userAsks = messages.filter((m) => m.role === 'user')
    if (userAsks.length > 0) {
      lines.push('Requests made so far:')
      for (const m of userAsks) {
        if (m.content.kind === 'text') lines.push(`- ${truncate(m.content.text, 200)}`)
      }
      lines.push('')
    }

    const activity = messages.filter((m) => m.role === 'assistant' && m.content.kind === 'activity')
    if (activity.length > 0) {
      lines.push('Actions taken:')
      for (const m of activity) {
        if (m.content.kind === 'activity') lines.push(`- ${m.content.summary}`)
      }
      lines.push('')
    }

    const lastAssistantText = [...messages]
      .reverse()
      .find((m) => m.role === 'assistant' && m.content.kind === 'text')
    if (lastAssistantText?.content.kind === 'text') {
      lines.push('Most recent response:')
      lines.push(truncate(lastAssistantText.content.text, 800))
    }

    return lines.join('\n').trim()
  },

  async execute(input: HandoffExecuteInput, onSessionCreated?: (session: Session) => void): Promise<Session> {
    const source = sessionRepo.get(input.sourceSessionId)
    if (!source) throw new Error('Session not found.')

    const newSession = sessionService.create({
      workspaceId: source.workspaceId,
      agentId: input.destinationAgentId,
      title: `${source.title} (continued)`
    })
    // Give the caller a chance to wire event forwarding before sendPrompt
    // starts emitting — otherwise the first few events could fire before
    // any renderer subscription exists.
    onSessionCreated?.(newSession)

    const prompt = input.additionalInstruction.trim()
      ? `${input.summary}\n\nAdditional instruction: ${input.additionalInstruction.trim()}`
      : input.summary

    await sessionService.sendPrompt(newSession.id, prompt)
    return newSession
  }
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}
