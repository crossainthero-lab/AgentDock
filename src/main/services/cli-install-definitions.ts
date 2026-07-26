// Static, per-agent "what does 'Install for me' actually run" data — kept
// separate from cli-installation-service.ts (the thing that actually runs
// it) so the install commands themselves are easy to audit/update without
// touching any process-spawning logic. Every command here is the CLI
// vendor's own officially documented install method (npm global install of
// their real published package) — never a third-party script, never a
// binary fetched from an unofficial URL, per the CLI Setup Assistant's own
// safety requirements.
import type { AgentId } from '@shared/types'

export interface CliInstallDefinition {
  agentId: AgentId
  /** True when AgentDock knows a safe, official, scriptable install command
   *  for this agent on the current platform. False means "manual only" —
   *  Antigravity today, since there is no confirmed official npm/package
   *  install command AgentDock can run on the user's behalf. */
  supported: boolean
  /** Package manager's own executable name — resolved to a real, verified
   *  path the same way agent CLIs are (see executable-resolver.ts), never
   *  assumed to be on PATH as a bare shell command. */
  packageManagerCommand: string
  /** Argv passed to packageManagerCommand — a plain array, never a shell
   *  string, so nothing here is ever subject to shell interpretation. */
  installArgs: string[]
  /** One-line explanation of what will run, shown to the user before they
   *  confirm anything. */
  summary: string
  /** The exact command line, formatted for display only. */
  displayCommand: string
  /** A real `npm install -g` never needs elevated privileges on any
   *  platform AgentDock supports (it writes under the user's own npm
   *  global prefix) — kept as an explicit field rather than assumed, so a
   *  future install method that genuinely does need elevation has
   *  somewhere honest to say so instead of silently requesting it. */
  requiresAdmin: boolean
  manualInstructions: string
  /** Only ever a real, well-known official vendor domain — never guessed. */
  manualUrl: string | null
}

const CLAUDE_CODE: CliInstallDefinition = {
  agentId: 'claude-code',
  supported: true,
  packageManagerCommand: 'npm',
  installArgs: ['install', '-g', '@anthropic-ai/claude-code'],
  summary: "Installs Anthropic's official Claude Code CLI globally via npm — the officially documented install method.",
  displayCommand: 'npm install -g @anthropic-ai/claude-code',
  requiresAdmin: false,
  manualInstructions:
    'Install Node.js 18+ if you haven\'t already, then run "npm install -g @anthropic-ai/claude-code" in a terminal. See Anthropic\'s official Claude Code documentation for other install methods (e.g. the native installer) and for signing in.',
  manualUrl: 'https://docs.claude.com/en/docs/claude-code/overview'
}

const CODEX: CliInstallDefinition = {
  agentId: 'codex',
  supported: true,
  packageManagerCommand: 'npm',
  installArgs: ['install', '-g', '@openai/codex'],
  summary: "Installs OpenAI's official Codex CLI globally via npm — the officially documented install method.",
  displayCommand: 'npm install -g @openai/codex',
  requiresAdmin: false,
  manualInstructions:
    'Install Node.js 18+ if you haven\'t already, then run "npm install -g @openai/codex" in a terminal. See OpenAI\'s official Codex documentation for other install methods and for signing in.',
  manualUrl: 'https://github.com/openai/codex'
}

// Deliberately unsupported for one-click install: unlike Claude Code and
// Codex, AgentDock has no independently confirmed official, scriptable
// install command for Google's Antigravity CLI (`agy`) — guessing one and
// running it would violate the "never guess an install method" and "never
// download/execute from an unofficial source" requirements. Manual install
// only, until a real official command can be confirmed and added here.
const ANTIGRAVITY: CliInstallDefinition = {
  agentId: 'antigravity',
  supported: false,
  packageManagerCommand: '',
  installArgs: [],
  summary: 'AgentDock does not yet support one-click installation for Antigravity.',
  displayCommand: '',
  requiresAdmin: false,
  manualInstructions:
    "Install Google's Antigravity CLI (`agy`) using Google's own official Antigravity documentation for your operating system, then sign in as instructed there. Once installed and on PATH, AgentDock will detect it automatically — use \"Check again\" below.",
  manualUrl: null
}

const DEFINITIONS: Record<AgentId, CliInstallDefinition> = {
  'claude-code': CLAUDE_CODE,
  codex: CODEX,
  antigravity: ANTIGRAVITY
}

export function getInstallDefinition(agentId: AgentId): CliInstallDefinition {
  return DEFINITIONS[agentId]
}
