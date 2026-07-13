import { execFile } from 'node:child_process'
import type { AgentDetection, AgentId } from '@shared/types'
import { describeResolutionFailure, resolveExecutable } from './executable-resolver'

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

function runVersionProbe(executable: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(executable, args, { shell: true, timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        resolve(null)
        return
      }
      resolve(stdout || stderr || '')
    })
  })
}

async function detectOne(spec: DetectionSpec, customPath: string | null): Promise<AgentDetection> {
  const resolution = resolveExecutable(spec.candidates, customPath)

  if (!resolution.resolvedPath) {
    console.error(`[detection] ${spec.agentId}:`, describeResolutionFailure({
      agentId: spec.agentId,
      candidates: spec.candidates,
      customPath,
      workspacePath: '(not applicable during detection)',
      result: resolution
    }))
    return {
      agentId: spec.agentId,
      installed: false,
      version: null,
      executablePath: null,
      error: customPath
        ? `Could not find an executable at the configured custom path "${customPath}" (checked ${resolution.checked.length} variants). Check the custom path in Settings.`
        : `"${spec.candidates.join('", "')}" not found on PATH (searched ${resolution.pathDirCount} directories). Checked ${resolution.checked.length} path/extension combinations.`,
      structuredOutput: spec.structuredOutput
    }
  }

  const output = await runVersionProbe(resolution.resolvedPath, spec.versionArgs)
  console.log(`[detection] ${spec.agentId} resolved to: ${resolution.resolvedPath}`)

  return {
    agentId: spec.agentId,
    installed: true,
    version: output ? spec.parseVersion(output) : null,
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
  }
}
