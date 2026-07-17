// Process-spawning primitive for structured-JSON-transport agents (Claude,
// Codex) — a plain child_process, not a PTY. These CLIs run non-interactive
// (`-p`/`exec`) and speak newline-delimited JSON on stdout; there's no
// terminal to reconstruct, no ANSI, no resize, and no deliverable Ctrl+C
// (a one-shot process is simply killed to "interrupt" it). Sibling to
// pty-service.ts, which stays the primitive for Antigravity's genuinely
// interactive PTY session.
import { spawn, type ChildProcess } from 'node:child_process'

export interface ChildSpawnOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
}

export interface ProcessExitInfo {
  exitCode: number | null
  signal: number | null
}

export interface ManagedChildProcess {
  readonly pid: number | undefined
  kill(): void
  /** Newline-delimited JSON on stdout, one complete line per call — chunk
   *  boundaries never align with line boundaries, so this buffers a partial
   *  trailing line across `data` events until a `\n` completes it. */
  onLine(cb: (line: string) => void): () => void
  onExit(cb: (info: ProcessExitInfo) => void): () => void
  readonly isRunning: boolean
}

let nextId = 1

class ManagedChild implements ManagedChildProcess {
  readonly id = String(nextId++)
  private readonly proc: ChildProcess
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly exitListeners = new Set<(info: ProcessExitInfo) => void>()
  private buffer = ''
  private running = true

  constructor(command: string, args: string[], options: ChildSpawnOptions) {
    console.log(`[child-process] spawning "${command}" args=${JSON.stringify(args)} cwd="${options.cwd}"`)

    this.proc = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      shell: false
    })
    console.log(`[child-process] spawned pid=${this.proc.pid}`)

    this.proc.stdout?.setEncoding('utf8')
    this.proc.stdout?.on('data', (chunk: string) => this.onChunk(chunk))
    this.proc.stderr?.setEncoding('utf8')
    this.proc.stderr?.on('data', (chunk: string) => console.warn(`[child-process] pid=${this.proc.pid} stderr: ${chunk}`))

    this.proc.on('exit', (exitCode, signal) => {
      console.log(`[child-process] pid=${this.proc.pid} exited exitCode=${exitCode} signal=${signal ?? 'none'}`)
      this.running = false
      if (this.buffer.trim()) {
        this.emitLine(this.buffer)
        this.buffer = ''
      }
      const numericSignal = typeof signal === 'string' ? null : (signal ?? null)
      for (const listener of this.exitListeners) listener({ exitCode, signal: numericSignal })
    })
  }

  private onChunk(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim()) this.emitLine(line)
    }
  }

  private emitLine(line: string): void {
    for (const listener of this.lineListeners) listener(line)
  }

  get pid(): number | undefined {
    return this.proc.pid
  }

  get isRunning(): boolean {
    return this.running
  }

  kill(): void {
    if (!this.running) return
    this.proc.kill()
  }

  onLine(cb: (line: string) => void): () => void {
    this.lineListeners.add(cb)
    return () => this.lineListeners.delete(cb)
  }

  onExit(cb: (info: ProcessExitInfo) => void): () => void {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }
}

const liveProcesses = new Set<ManagedChild>()

export const childProcessService = {
  spawn(command: string, args: string[], options: ChildSpawnOptions): ManagedChildProcess {
    const proc = new ManagedChild(command, args, options)
    liveProcesses.add(proc)
    proc.onExit(() => liveProcesses.delete(proc))
    return proc
  },

  /** Kills every live structured-transport process. Called on app quit
   *  alongside ptyService.killAll() so no orphaned agent processes survive
   *  AgentDock closing. */
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
