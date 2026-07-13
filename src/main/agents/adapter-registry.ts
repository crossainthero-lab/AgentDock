import type { AgentId } from '@shared/types'
import type { AgentAdapter } from './agent-adapter'
import { claudeAdapter } from './claude/ClaudeAdapter'
import { codexAdapter } from './codex/CodexAdapter'
import { antigravityAdapter } from './antigravity/AntigravityAdapter'

const registry: Record<AgentId, AgentAdapter> = {
  'claude-code': claudeAdapter,
  codex: codexAdapter,
  antigravity: antigravityAdapter
}

export function getAdapter(agentId: AgentId): AgentAdapter {
  return registry[agentId]
}

export function allAdapters(): AgentAdapter[] {
  return Object.values(registry)
}
