// Process-spawning primitive shared by every agent adapter and the Terminal
// drawer. Backed by a real pseudo-terminal (node-pty, ConPTY on Windows) —
// every process AgentDock starts gets a genuine TTY: interactive prompts,
// ANSI output, cursor control, real resize, and a deliverable Ctrl+C all
// work exactly as they would in a real terminal window.
import * as pty from 'node-pty'

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
    console.log(`[pty] spawning "${file}" args=${JSON.stringify(args)} cwd="${options.cwd}"`)

    this.proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: options.cols ?? 120,
      rows: options.rows ?? 30,
      cwd: options.cwd,
      env: options.env ?? process.env,
      useConpty: true
    })
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
