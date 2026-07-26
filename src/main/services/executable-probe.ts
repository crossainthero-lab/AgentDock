// A real subprocess `--version` probe against a resolved executable path —
// extracted out of detection-service.ts so codex-runtime-resolver.ts can
// share the exact same, already-proven spawn mechanism (cross-spawn, no
// shell, correctly handles a native .exe, an npm .cmd shim, or a .bat file
// uniformly on Windows) instead of re-deriving it. This is what actually
// proves a resolved path is a working executable, not just a file that
// happens to exist with the right name.
import spawn from 'cross-spawn'
import { validateSpawnPlan } from './spawn-guard'

export interface ProbeOutcome {
  ok: boolean
  /** Human-readable reason the candidate was rejected — surfaced in
   *  diagnostics. Only meaningful when ok is false. */
  reason?: string
  /** Raw stdout/stderr from the probe when it succeeded — lets the caller
   *  parse a version string without re-running a second probe. */
  output?: string
}

const PROBE_TIMEOUT_MS = 5000

export function probeExecutable(executable: string, args: string[]): Promise<ProbeOutcome> {
  try {
    validateSpawnPlan({ command: executable, args })
  } catch (err) {
    return Promise.resolve({ ok: false, reason: err instanceof Error ? err.message : String(err) })
  }

  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''

    const child = spawn(executable, args, { windowsHide: true })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ ok: false, reason: `timed out after ${PROBE_TIMEOUT_MS}ms` })
    }, PROBE_TIMEOUT_MS)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.once('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const code = (err as NodeJS.ErrnoException).code
      resolve({ ok: false, reason: code ? `${code}: ${err.message}` : err.message })
    })

    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve({ ok: true, output: stdout || stderr })
      else resolve({ ok: false, reason: `exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}` })
    })
  })
}
