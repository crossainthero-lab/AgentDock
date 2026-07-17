// Static capability declarations, grounded in real CLI output captured
// during development (see each agent's classifier/adapter comments) rather
// than guessed. The renderer only shows a Model/Permissions/Commands control
// when the relevant list here is non-empty, so an agent that doesn't
// support something simply doesn't get offered it.
import type { AgentCapabilities, AgentId } from '@shared/types'

const claudeCapabilities: AgentCapabilities = {
  agentId: 'claude-code',
  // Real `--model` flag values, verified against `claude --help`
  // ("Provide an alias for the latest model ... or a model's full name").
  // The structured transport is process-per-turn (see ClaudeAdapter), so
  // there is no live interactive picker anymore — these ids are passed
  // straight through as `--model <id>` on the next turn's spawn.
  models: [
    { id: 'sonnet', label: 'Sonnet', description: 'Sonnet 5 · efficient for routine tasks' },
    { id: 'fable', label: 'Fable', description: 'Fable 5 · most capable for hard/long tasks' },
    { id: 'opus', label: 'Opus', description: 'Opus 4.8 · best for complex tasks' },
    { id: 'haiku', label: 'Haiku', description: 'Haiku 4.5 · fastest for quick answers' }
  ],
  permissionModes: [
    { id: 'default', label: 'Default', description: 'Ask before edits and risky commands' },
    { id: 'acceptEdits', label: 'Accept edits', description: 'Auto-approve file edits' },
    { id: 'plan', label: 'Plan', description: 'Plan only, no execution' },
    { id: 'bypassPermissions', label: 'Bypass permissions', description: 'Never ask (dangerous)' }
  ],
  // No confirmed one-shot-process equivalent of the interactive /clear,
  // /compact, /cost, /doctor, /init slash commands — left empty rather than
  // guessing a CLI flag/command that might not exist for `claude -p`.
  commands: [],
  // "Live" now means "applies starting the next turn" (each turn is a
  // fresh process — see ClaudeAdapter.setModel) rather than a mid-turn
  // interactive picker.
  supportsLiveModelSwitch: true,
  // Permission mode is only applied at process spawn (--permission-mode);
  // changes apply the next time a turn spawns a new process.
  supportsLivePermissionSwitch: false,
  authState: 'unknown'
}

const codexCapabilities: AgentCapabilities = {
  agentId: 'codex',
  // No verified model list/command for `codex exec` — left empty rather
  // than guessing model ids that might not exist.
  models: [],
  // Real values from `codex exec --help` — non-interactive Codex has no
  // approval prompt to ask (there's no one to answer it), so this is a
  // sandbox policy (-s/--sandbox), not an ask-for-approval mode like the
  // old interactive TUI had. Applied at spawn only (see CodexAdapter).
  permissionModes: [
    { id: 'default', label: 'Default', description: "Use Codex's configured sandbox policy" },
    { id: 'read-only', label: 'Read-only', description: '--sandbox read-only' },
    { id: 'workspace-write', label: 'Workspace write', description: '--sandbox workspace-write' },
    { id: 'danger-full-access', label: 'Full access (dangerous)', description: '--sandbox danger-full-access' },
    { id: 'bypass', label: 'Bypass (dangerous)', description: '--dangerously-bypass-approvals-and-sandbox' }
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
