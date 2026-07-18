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
  // Genuinely live now — ClaudeAdapter is backed by the Claude Agent SDK's
  // persistent Query (see ClaudeAgentSdkTransport), whose Query.setModel()
  // takes effect for the next response without restarting the process.
  models: [
    { id: 'sonnet', label: 'Sonnet', description: 'Sonnet 5 · efficient for routine tasks' },
    { id: 'fable', label: 'Fable', description: 'Fable 5 · most capable for hard/long tasks' },
    { id: 'opus', label: 'Opus', description: 'Opus 4.8 · best for complex tasks' },
    { id: 'haiku', label: 'Haiku', description: 'Haiku 4.5 · fastest for quick answers' }
  ],
  // The SDK's own `PermissionMode` type (@anthropic-ai/claude-agent-sdk,
  // sdk.d.ts) — not the CLI's `--help` text, which lists a slightly
  // different/stale set including "manual". 'default' is AgentDock's own
  // sentinel for "omit the option, use the CLI's built-in default" (see
  // ClaudeAgentSdkTransport's normalizePermissionMode).
  permissionModes: [
    { id: 'default', label: 'Default', description: 'Ask before edits and risky commands' },
    { id: 'acceptEdits', label: 'Accept edits', description: 'Auto-approve file edits' },
    { id: 'plan', label: 'Plan', description: 'Plan only, no execution' },
    { id: 'bypassPermissions', label: 'Bypass permissions', description: 'Never ask (dangerous)' },
    { id: 'dontAsk', label: "Don't ask", description: 'Deny anything not already pre-approved' },
    { id: 'auto', label: 'Auto', description: 'A model classifier approves or denies for you' }
  ],
  // No confirmed one-shot-process equivalent of the interactive /clear,
  // /compact, /cost, /doctor, /init slash commands — left empty rather than
  // guessing a CLI flag/command that might not exist for `claude -p`.
  commands: [],
  // Genuinely live via Query.setModel()/Query.setPermissionMode() — both
  // require the SDK's streaming-input mode, which ClaudeAgentSdkTransport
  // always uses (confirmed live: "Only available in streaming input mode"
  // per the SDK's own Query interface doc).
  supportsLiveModelSwitch: true,
  supportsLivePermissionSwitch: true,
  authState: 'unknown'
}

const codexCapabilities: AgentCapabilities = {
  agentId: 'codex',
  // No verified model list/command for `codex exec` — left empty rather
  // than guessing model ids that might not exist.
  models: [],
  // Real sandbox modes the Codex SDK's ThreadOptions.sandboxMode accepts
  // (see CodexAgentSdkTransport.ts) — non-interactive Codex has no approval
  // prompt to ask (there's no one to answer it), so this is a sandbox
  // policy, not an ask-for-approval mode like the old interactive TUI had.
  // Applied at thread-creation only (see CodexAdapter/CodexAgentSdkTransport).
  permissionModes: [
    { id: 'default', label: 'Default', description: "Use Codex's configured sandbox policy" },
    { id: 'read-only', label: 'Read-only', description: 'sandboxMode: read-only' },
    { id: 'workspace-write', label: 'Workspace write', description: 'sandboxMode: workspace-write' },
    { id: 'danger-full-access', label: 'Full access (dangerous)', description: 'sandboxMode: danger-full-access' },
    {
      id: 'bypass',
      label: 'Bypass (dangerous)',
      description: 'danger-full-access + never-ask — the SDK has no exact equivalent of the CLI\'s dedicated bypass flag'
    }
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
