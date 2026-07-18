import { execFile } from 'node:child_process'
import type { AgentDetection, AgentId } from '@shared/types'
import { describeResolutionFailure, resolveExecutable, type ValidateCandidate, type ValidationOutcome } from './executable-resolver'

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

const PROBE_TIMEOUT_MS = 5000

/** Runs a real subprocess probe against a candidate path — this is what
 *  actually proves a resolved path is a working executable, not just a
 *  file that happens to exist with the right name (see
 *  executable-resolver.ts's module comment for the exact bug this
 *  prevents: an existsSync-only check previously accepted a POSIX shell
 *  shim that Windows cannot execute). `shell: true` is required here, not
 *  optional — it's what lets this same code path correctly launch a
 *  native .exe, an npm .cmd shim, or a .bat file uniformly: the shell
 *  itself resolves and executes whichever format the candidate is,
 *  instead of AgentDock needing to special-case each one. */
function probeCandidate(executable: string, args: string[]): Promise<ValidationOutcome> {
  return new Promise((resolve) => {
    execFile(executable, args, { shell: true, timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const reason =
          'code' in error && error.code === 'ETIMEDOUT'
            ? `timed out after ${PROBE_TIMEOUT_MS}ms`
            : (error as NodeJS.ErrnoException).code
              ? `${(error as NodeJS.ErrnoException).code}: ${error.message}`
              : error.message
        resolve({ ok: false, reason })
        return
      }
      resolve({ ok: true, output: stdout || stderr || '' })
    })
  })
}

function makeValidator(spec: DetectionSpec): ValidateCandidate {
  return (path) => probeCandidate(path, spec.versionArgs)
}

function executableType(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.exe')) return 'exe'
  if (lower.endsWith('.cmd')) return 'cmd (npm shim)'
  if (lower.endsWith('.bat')) return 'bat'
  if (lower.endsWith('.com')) return 'com'
  if (lower.endsWith('.ps1')) return 'PowerShell script'
  return 'unknown'
}

async function detectOne(spec: DetectionSpec, customPath: string | null): Promise<AgentDetection> {
  const resolution = await resolveExecutable(spec.candidates, customPath, makeValidator(spec))

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

export const detectionService = {
  async detect(agentId: AgentId, customPath: string | null): Promise<AgentDetection> {
    const spec = SPECS.find((s) => s.agentId === agentId)
    if (!spec) throw new Error(`Unknown agent id: ${agentId}`)
    return detectOne(spec, customPath)
  },

  async detectAll(customPaths: Partial<Record<AgentId, string | null>>): Promise<AgentDetection[]> {
    return Promise.all(SPECS.map((spec) => detectOne(spec, customPaths[spec.agentId] ?? null)))
  },

  resolveCommand(agentId: AgentId): string {
    const spec = SPECS.find((s) => s.agentId === agentId)
    if (!spec) throw new Error(`Unknown agent id: ${agentId}`)
    return spec.candidates[0]
  },

  /** Explicit "Test" action for the Settings UI: validates one specific
   *  path (not a PATH search) and returns full diagnostics — resolved
   *  path, executable type, version, and raw probe output/error. Used so
   *  a user can confirm a custom override actually works before saving it
   *  as their configured path. */
  async testExecutable(agentId: AgentId, path: string): Promise<{
    path: string
    type: string
    ok: boolean
    version: string | null
    output: string | null
    error: string | null
  }> {
    const spec = SPECS.find((s) => s.agentId === agentId)
    if (!spec) throw new Error(`Unknown agent id: ${agentId}`)
    const probe = await probeCandidate(path, spec.versionArgs)
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
