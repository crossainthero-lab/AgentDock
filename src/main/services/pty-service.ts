// Process-spawning primitive shared by every agent adapter and the Terminal
// drawer. Backed by a real pseudo-terminal (node-pty, ConPTY on Windows) —
// every process AgentDock starts gets a genuine TTY: interactive prompts,
// ANSI output, cursor control, real resize, and a deliverable Ctrl+C all
// work exactly as they would in a real terminal window.
import * as pty from 'node-pty'
import { basename } from 'node:path'
import { isWindowsShim, resolveShimTarget } from './windows-shim-resolver'
import { validateSpawnPlan } from './spawn-guard'
import { buildSpawnDiagnostics, formatSpawnDiagnostics } from './spawn-diagnostics'

export interface SpawnOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  cols?: number
  rows?: number
}

export interface ProcessExitInfo {
  exitCode: number | null
  signal: number | null
}

export interface ManagedProcess {
  id: string
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  interrupt(): void
  kill(): void
  onData(cb: (chunk: string) => void): () => void
  onExit(cb: (info: ProcessExitInfo) => void): () => void
  readonly isRunning: boolean
}

let nextId = 1

class PtyProcess implements ManagedProcess {
  readonly id = String(nextId++)
  readonly pid: number
  private readonly proc: pty.IPty
  private readonly dataListeners = new Set<(chunk: string) => void>()
  private readonly exitListeners = new Set<(info: ProcessExitInfo) => void>()
  private running = true

  constructor(file: string, args: string[], options: SpawnOptions) {
    // node-pty's own pty.spawn() on Windows ultimately goes through
    // CreateProcess (via ConPTY) just like a plain child_process.spawn —
    // it has no more ability to launch a `.cmd`/`.bat` shim directly than
    // raw spawn does, and no built-in shim-resolution of its own. Resolving
    // to the shim's real target here (rather than at each individual
    // caller — Antigravity's session, the Terminal drawer, any future PTY
    // consumer) means every PTY launch in AgentDock gets this fix for
    // free. See windows-shim-resolver.ts's module comment for the full
    // root-cause explanation.
    let resolvedFile = file
    let resolvedArgs = args
    const agentLabel = basename(file)

    try {
      if (isWindowsShim(file)) {
        const target = resolveShimTarget(file)
        if (!target) {
          throw new Error(
            `"${file}" is a Windows .cmd/.bat shim AgentDock could not resolve to a real executable. ` +
              'Set a direct path to the underlying .exe as a custom path in Settings, or reinstall this CLI using its native Windows installer instead of npm.'
          )
        }
        resolvedFile = target.command
        resolvedArgs = [...target.args, ...args]
      }

      validateSpawnPlan({ command: resolvedFile, args: resolvedArgs, cwd: options.cwd, env: options.env })
      console.log(`[pty] spawning "${resolvedFile}" args=${JSON.stringify(resolvedArgs)} cwd="${options.cwd}"`)

      this.proc = pty.spawn(resolvedFile, resolvedArgs, {
        name: 'xterm-256color',
        cols: options.cols ?? 120,
        rows: options.rows ?? 30,
        cwd: options.cwd,
        env: options.env ?? process.env,
        useConpty: true
      })
    } catch (error) {
      const diagnostics = buildSpawnDiagnostics({
        agentId: agentLabel,
        mechanism: 'pty',
        executablePath: resolvedFile,
        args: resolvedArgs,
        cwd: options.cwd,
        error
      })
      console.error('[pty] spawn failed:', formatSpawnDiagnostics(diagnostics))
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${formatSpawnDiagnostics(diagnostics)}`)
    }
    this.pid = this.proc.pid
    console.log(`[pty] spawned pid=${this.pid}`)

    this.proc.onData((chunk) => {
      for (const listener of this.dataListeners) listener(chunk)
    })

    this.proc.onExit(({ exitCode, signal }) => {
      console.log(`[pty] pid=${this.pid} exited exitCode=${exitCode} signal=${signal ?? 'none'}`)
      this.running = false
      for (const listener of this.exitListeners) {
        listener({ exitCode, signal: signal ?? null })
      }
    })
  }

  get isRunning(): boolean {
    return this.running
  }

  write(data: string): void {
    if (!this.running) {
      console.warn(`[pty] write() ignored — pid=${this.pid} is not running`)
      return
    }
    this.proc.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.running) return
    try {
      this.proc.resize(cols, rows)
    } catch (err) {
      console.warn(`[pty] resize(${cols}, ${rows}) failed for pid=${this.pid}:`, err)
    }
  }

  interrupt(): void {
    if (!this.running) return
    // A real PTY can deliver an actual Ctrl+C to whatever's reading stdin,
    // unlike a plain pipe where SIGINT isn't deliverable to arbitrary
    // Windows processes.
    this.proc.write('\x03')
  }

  kill(): void {
    if (!this.running) return
    this.proc.kill()
  }

  onData(cb: (chunk: string) => void): () => void {
    this.dataListeners.add(cb)
    return () => this.dataListeners.delete(cb)
  }

  onExit(cb: (info: ProcessExitInfo) => void): () => void {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }
}

const liveProcesses = new Set<PtyProcess>()

export const ptyService = {
  spawn(command: string, args: string[], options: SpawnOptions): ManagedProcess {
    const proc = new PtyProcess(command, args, options)
    liveProcesses.add(proc)
    proc.onExit(() => liveProcesses.delete(proc))
    return proc
  },

  /** Kills every live PTY. Called on app quit so no orphaned agent processes survive AgentDock closing. */
  killAll(): void {
    for (const proc of liveProcesses) {
      try {
        proc.kill()
      } catch {
        // best-effort on shutdown
      }
    }
    liveProcesses.clear()
  }
}
