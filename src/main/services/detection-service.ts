import type { AgentDetection, AgentId } from '@shared/types'
import { describeResolutionFailure, knownInstallDirs, resolveExecutable, type ValidateCandidate } from './executable-resolver'
import { probeExecutable } from './executable-probe'
import { resolveCodexRuntime } from './codex-runtime-resolver'

interface DetectionSpec {
  agentId: AgentId
  /** Candidate executable names tried in order, first hit wins. */
  candidates: string[]
  versionArgs: string[]
  /** Pull a version string out of the CLI's --version output. */
  parseVersion(stdout: string): string | null
  structuredOutput: boolean
}

const SPECS: DetectionSpec[] = [
  {
    agentId: 'claude-code',
    candidates: ['claude'],
    versionArgs: ['--version'],
    parseVersion: (stdout) => stdout.trim().split('\n')[0]?.trim() || null,
    structuredOutput: true
  },
  {
    // Kept for resolveCommand/structuredOutputFor/testExecutable (see their
    // own doc comments below) — but `codex` never goes through this spec's
    // `candidates`-based PATH search for actual detection. A bare `codex`
    // command on Windows commonly resolves to an npm `codex.cmd` shim that
    // the generic PATH-search-then-probe flow below would happily accept
    // (cross-spawn's probe CAN run a `.cmd` via cmd.exe), but
    // @openai/codex-sdk's own internal spawn call cannot launch one
    // directly — see codex-runtime-resolver.ts's module comment for the
    // full fix. `detect()`/`detectAll()` special-case 'codex' to call
    // `detectCodex()` instead, which never treats a shim as usable at any
    // priority tier and never even searches PATH for a global install.
    agentId: 'codex',
    candidates: ['codex'],
    versionArgs: ['--version'],
    parseVersion: (stdout) => stdout.trim().split('\n')[0]?.trim() || null,
    structuredOutput: true
  },
  {
    agentId: 'antigravity',
    // "agy" is the real, verified Antigravity CLI executable name on this
    // machine (confirmed via `where agy` / `agy --version`). The other two
    // are kept as low-priority fallbacks in case a different install layout
    // uses them, but are unverified guesses.
    candidates: ['agy', 'antigravity', 'google-antigravity'],
    versionArgs: ['--version'],
    parseVersion: (stdout) => stdout.trim().split('\n')[0]?.trim() || null,
    structuredOutput: false
  }
]

function specFor(agentId: AgentId): DetectionSpec {
  const spec = SPECS.find((s) => s.agentId === agentId)
  if (!spec) throw new Error(`Unknown agent id: ${agentId}`)
  return spec
}

function makeValidator(spec: DetectionSpec): ValidateCandidate {
  return (path) => probeExecutable(path, spec.versionArgs)
}

function executableType(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.exe')) return 'exe'
  if (lower.endsWith('.cmd')) return 'cmd (npm shim)'
  if (lower.endsWith('.bat')) return 'bat'
  if (lower.endsWith('.com')) return 'com'
  if (lower.endsWith('.ps1')) return 'PowerShell script'
  if (process.platform !== 'win32') return 'binary'
  return 'unknown'
}

/** The generic PATH-search-then-probe detection every agent except Codex
 *  uses — unchanged from before this fix. */
async function detectOne(spec: DetectionSpec, customPath: string | null): Promise<AgentDetection> {
  const resolution = await resolveExecutable(spec.candidates, customPath, makeValidator(spec), knownInstallDirs())

  if (!resolution.resolvedPath) {
    console.error(
      `[detection] ${spec.agentId}:`,
      describeResolutionFailure({
        agentId: spec.agentId,
        candidates: spec.candidates,
        customPath,
        workspacePath: '(not applicable during detection)',
        result: resolution
      })
    )
    return {
      agentId: spec.agentId,
      installed: false,
      version: null,
      executablePath: null,
      error: customPath
        ? `Could not find a working executable at the configured custom path "${customPath}" (checked ${resolution.checked.length} variants${
            resolution.rejected.length > 0 ? `, ${resolution.rejected.length} existed but failed to run` : ''
          }). Check the custom path in Settings.`
        : `"${spec.candidates.join('", "')}" not found or not runnable on PATH (searched ${resolution.pathDirCount} directories, ${
            resolution.checked.length
          } path/extension combinations${resolution.rejected.length > 0 ? `, ${resolution.rejected.length} existed but failed to run` : ''}).`,
      structuredOutput: spec.structuredOutput
    }
  }

  console.log(
    `[detection] ${spec.agentId} resolved to: ${resolution.resolvedPath} (${executableType(resolution.resolvedPath)}, strategy: ${resolution.strategy})`
  )

  return {
    agentId: spec.agentId,
    installed: true,
    version: resolution.output ? spec.parseVersion(resolution.output) : null,
    executablePath: resolution.resolvedPath,
    error: null,
    structuredOutput: spec.structuredOutput
  }
}

/** Codex-specific detection — delegates entirely to
 *  codex-runtime-resolver.ts's 4-tier priority (custom .exe > SDK-bundled
 *  native runtime > standalone .exe > error) instead of the generic
 *  PATH-search above, so a `codex.cmd` shim on PATH is never reported as a
 *  working install the way the generic path would. `resolutionSource` on
 *  the returned AgentDetection is what session-service.ts threads through
 *  to CodexAgentSdkTransport so it knows whether to pass
 *  `codexPathOverride` at all (see AgentRunContext.executablePathSource's
 *  doc comment). */
async function detectCodex(customPath: string | null): Promise<AgentDetection> {
  const spec = specFor('codex')
  const resolution = await resolveCodexRuntime(customPath)

  if (resolution.source === 'none' || !resolution.nativeExecutablePath) {
    console.error(`[detection] codex: ${resolution.error}`)
    return {
      agentId: 'codex',
      installed: false,
      version: null,
      executablePath: null,
      error: resolution.error ?? 'Codex could not be located.',
      structuredOutput: spec.structuredOutput
    }
  }

  console.log(`[detection] codex resolved to: ${resolution.nativeExecutablePath} (source: ${resolution.source})`)

  return {
    agentId: 'codex',
    installed: true,
    version: resolution.versionProbe?.output ? spec.parseVersion(resolution.versionProbe.output) : null,
    executablePath: resolution.nativeExecutablePath,
    error: null,
    structuredOutput: spec.structuredOutput,
    resolutionSource: resolution.source
  }
}

export const detectionService = {
  async detect(agentId: AgentId, customPath: string | null): Promise<AgentDetection> {
    if (agentId === 'codex') return detectCodex(customPath)
    return detectOne(specFor(agentId), customPath)
  },

  async detectAll(customPaths: Partial<Record<AgentId, string | null>>): Promise<AgentDetection[]> {
    return Promise.all(SPECS.map((spec) => this.detect(spec.agentId, customPaths[spec.agentId] ?? null)))
  },

  resolveCommand(agentId: AgentId): string {
    return specFor(agentId).candidates[0]
  },

  structuredOutputFor(agentId: AgentId): boolean {
    return specFor(agentId).structuredOutput
  },

  /** Explicit "Test" action for the Settings UI: validates one specific
   *  path (not a PATH search) and returns full diagnostics — resolved
   *  path, executable type, version, and raw probe output/error. Used so
   *  a user can confirm a custom override actually works before saving it
   *  as their configured path. Deliberately agent-agnostic and unchanged by
   *  this fix (a plain "does this path respond to --version" diagnostic is
   *  still an honest, useful answer even for a `.cmd` — the actual gate
   *  that rejects a `.cmd` for Codex specifically is the save-time
   *  validation in ipc/agent.ts's agentsSetCustomPath handler, not this
   *  read-only probe). */
  async testExecutable(agentId: AgentId, path: string): Promise<{
    path: string
    type: string
    ok: boolean
    version: string | null
    output: string | null
    error: string | null
  }> {
    const spec = specFor(agentId)
    const probe = await probeExecutable(path, spec.versionArgs)
    return {
      path,
      type: executableType(path),
      ok: probe.ok,
      version: probe.ok && probe.output ? spec.parseVersion(probe.output) : null,
      output: probe.output ?? null,
      error: probe.ok ? null : (probe.reason ?? 'Unknown error')
    }
  }
}
