// Static capability declarations, grounded in real CLI output captured
// during development (see each agent's classifier/adapter comments) rather
// than guessed. The renderer only shows a Model/Permissions/Commands control
// when the relevant list here is non-empty, so an agent that doesn't
// support something simply doesn't get offered it.
import type { AgentCapabilities, AgentId } from '@shared/types'

const claudeCapabilities: AgentCapabilities = {
  agentId: 'claude-code',
  // Real /model picker, captured against claude 2.1.207 (`--ax-screen-reader`
  // mode) — ids are the picker's own numbered positions, sent verbatim.
  models: [
    { id: '1', label: 'Default (recommended)', description: 'Sonnet 5 · efficient for routine tasks' },
    { id: '2', label: 'Sonnet', description: 'Sonnet 5 · efficient for routine tasks' },
    { id: '3', label: 'Fable', description: 'Fable 5 · most capable for hard/long tasks' },
    { id: '4', label: 'Opus', description: 'Opus 4.8 · best for complex tasks' },
    { id: '5', label: 'Haiku', description: 'Haiku 4.5 · fastest for quick answers' }
  ],
  permissionModes: [
    { id: 'default', label: 'Default', description: 'Ask before edits and risky commands' },
    { id: 'acceptEdits', label: 'Accept edits', description: 'Auto-approve file edits' },
    { id: 'plan', label: 'Plan', description: 'Plan only, no execution' },
    { id: 'bypassPermissions', label: 'Bypass permissions', description: 'Never ask (dangerous)' }
  ],
  commands: [
    { id: 'clear', label: 'Clear conversation', description: '/clear' },
    { id: 'compact', label: 'Compact conversation', description: '/compact' },
    { id: 'cost', label: 'Show cost', description: '/cost' },
    { id: 'doctor', label: 'Run doctor', description: '/doctor' },
    { id: 'init', label: 'Create CLAUDE.md', description: '/init' }
  ],
  supportsLiveModelSwitch: true,
  // Permission mode is only applied at process spawn (--permission-mode);
  // switching live wasn't verified against a real capture, so changes here
  // apply the next time the session's process restarts (safe, reuses the
  // existing Settings → Agents flag path).
  supportsLivePermissionSwitch: false,
  authState: 'unknown'
}

const codexCapabilities: AgentCapabilities = {
  agentId: 'codex',
  // No verified interactive model list/command for Codex — left empty
  // rather than guessing model ids that might not exist.
  models: [],
  // Real values from `codex --help` (-a/--ask-for-approval), for display
  // only — applied at spawn, not live (see CodexAdapter).
  permissionModes: [
    { id: 'untrusted', label: 'Untrusted', description: 'Only run trusted read-only commands without asking' },
    { id: 'on-request', label: 'On request', description: 'The model asks when it needs approval' },
    { id: 'never', label: 'Never ask', description: 'Never ask for approval' },
    { id: 'bypass', label: 'Bypass (dangerous)', description: 'Skip all confirmation and sandboxing' }
  ],
  commands: [],
  supportsLiveModelSwitch: false,
  supportsLivePermissionSwitch: false,
  authState: 'unknown'
}

const antigravityCapabilities: AgentCapabilities = {
  agentId: 'antigravity',
  // Real output of `agy models`.
  models: [
    { id: 'gemini-3.5-flash-medium', label: 'Gemini 3.5 Flash (Medium)' },
    { id: 'gemini-3.5-flash-high', label: 'Gemini 3.5 Flash (High)' },
    { id: 'gemini-3.5-flash-low', label: 'Gemini 3.5 Flash (Low)' },
    { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
    { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
    { id: 'claude-sonnet-4.6-thinking', label: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'claude-opus-4.6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
    { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }
  ],
  // Real flags from `agy --help` (--mode, --dangerously-skip-permissions),
  // applied at spawn only — no verified live-switch command.
  permissionModes: [
    { id: 'default', label: 'Default', description: 'Ask before risky actions' },
    { id: 'accept-edits', label: 'Accept edits', description: '--mode accept-edits' },
    { id: 'plan', label: 'Plan', description: '--mode plan' },
    { id: 'bypass', label: 'Bypass (dangerous)', description: '--dangerously-skip-permissions' }
  ],
  commands: [],
  // No verified live /model command for agy — model changes apply at the
  // next process restart via --model instead.
  supportsLiveModelSwitch: false,
  supportsLivePermissionSwitch: false,
  authState: 'unknown'
}

const registry: Record<AgentId, AgentCapabilities> = {
  'claude-code': claudeCapabilities,
  codex: codexCapabilities,
  antigravity: antigravityCapabilities
}

export function getCapabilities(agentId: AgentId): AgentCapabilities {
  return registry[agentId]
}
