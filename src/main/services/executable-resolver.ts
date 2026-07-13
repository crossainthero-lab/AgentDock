// Resolves a CLI executable to an absolute, verified-to-exist path using the
// same PATH/PATHEXT semantics Windows itself uses, instead of relying on a
// shell (execFile with shell:true) at detection time and a bare command name
// at spawn time — the mismatch between those two was the reason session
// spawning could silently fail even after detection reported an agent as
// installed. One resolver, used by both.
import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

export interface ResolveResult {
  /** Absolute path to the resolved executable, or null if nothing matched. */
  resolvedPath: string | null
  /** Every candidate name / extension / directory combination that was checked, in order. */
  checked: string[]
  pathDirCount: number
}

function windowsExtensions(): string[] {
  const raw = process.env.PATHEXT
  const exts = (raw ? raw.split(delimiter) : ['.COM', '.EXE', '.BAT', '.CMD'])
    .map((e) => e.trim())
    .filter(Boolean)
  // Always allow the bare name too (no extension), in case it's already a
  // fully-qualified filename or an extensionless script with a shebang.
  return ['', ...exts]
}

function pathDirs(): string[] {
  const raw = process.env.PATH ?? process.env.Path ?? ''
  return raw.split(delimiter).filter(Boolean)
}

/**
 * Resolves a single candidate (bare command name or absolute/relative path)
 * to an absolute path, trying every Windows PATHEXT extension. Non-Windows
 * platforms just check the candidate (and PATH dirs) as-is.
 */
function tryResolveOne(candidate: string, checked: string[]): string | null {
  const isWindows = process.platform === 'win32'
  const extensions = isWindows ? windowsExtensions() : ['']

  if (isAbsolute(candidate)) {
    for (const ext of extensions) {
      const full = ext && !candidate.toLowerCase().endsWith(ext.toLowerCase()) ? candidate + ext : candidate
      checked.push(full)
      if (existsSync(full)) return full
    }
    return null
  }

  // Bare command name: search every PATH directory.
  for (const dir of pathDirs()) {
    for (const ext of extensions) {
      const full = join(dir, ext && !candidate.toLowerCase().endsWith(ext.toLowerCase()) ? candidate + ext : candidate)
      checked.push(full)
      if (existsSync(full)) return full
    }
  }
  return null
}

export function resolveExecutable(candidates: string[], customPath: string | null): ResolveResult {
  const checked: string[] = []
  const ordered = customPath ? [customPath] : candidates

  for (const candidate of ordered) {
    const resolved = tryResolveOne(candidate, checked)
    if (resolved) {
      return { resolvedPath: resolved, checked, pathDirCount: pathDirs().length }
    }
  }

  return { resolvedPath: null, checked, pathDirCount: pathDirs().length }
}

/** Builds the detailed diagnostic message the task requires on resolution failure. */
export function describeResolutionFailure(params: {
  agentId: string
  candidates: string[]
  customPath: string | null
  workspacePath: string
  result: ResolveResult
}): string {
  const { agentId, candidates, customPath, workspacePath, result } = params
  const lines = [
    `Could not locate an executable for "${agentId}".`,
    `Candidates checked: ${candidates.join(', ') || '(none)'}`,
    `Configured custom path: ${customPath ?? '(none)'}`,
    `Workspace: ${workspacePath}`,
    `PATH directories searched: ${result.pathDirCount}`,
    `Full list of paths checked (${result.checked.length}):`,
    ...result.checked.map((p) => `  - ${p}`)
  ]
  return lines.join('\n')
}
