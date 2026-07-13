// Single owner of a session's PTY. Everything that needs the live process —
// the classification pipeline (via onSnapshot), the Terminal drawer fallback
// (via onRawData), and capability actions (write/resize/interrupt) — goes
// through one controller per session, so there is exactly one PTY no matter
// how many consumers are attached, and "Open terminal" always reveals the
// literal same session (never a second process, never a disconnected shell).
import { ptyService, type ManagedProcess, type ProcessExitInfo, type SpawnOptions } from '../services/pty-service'
import { TerminalScreenBuffer, type ScreenSnapshot } from './TerminalScreenBuffer'

export interface TerminalSessionController {
  readonly pid: number
  readonly isRunning: boolean
  write(data: string): void
  resize(cols: number, rows: number): void
  interrupt(): void
  kill(): void
  onRawData(cb: (chunk: string) => void): () => void
  /** Idle-debounced stable screen snapshot — what classifiers consume. */
  onSnapshot(cb: (snapshot: ScreenSnapshot) => void): () => void
  onExit(cb: (info: ProcessExitInfo) => void): () => void
}

const DEFAULT_IDLE_MS = 450

class TerminalSessionControllerImpl implements TerminalSessionController {
  private readonly proc: ManagedProcess
  private readonly screen: TerminalScreenBuffer
  private readonly rawListeners = new Set<(chunk: string) => void>()
  private readonly snapshotListeners = new Set<(snapshot: ScreenSnapshot) => void>()
  private readonly exitListeners = new Set<(info: ProcessExitInfo) => void>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(command: string, args: string[], options: SpawnOptions, private readonly idleMs: number) {
    this.screen = new TerminalScreenBuffer(options.cols ?? 120, options.rows ?? 30)
    this.proc = ptyService.spawn(command, args, options)

    this.proc.onData((chunk) => {
      this.screen.write(chunk)
      for (const l of this.rawListeners) l(chunk)
      this.scheduleSnapshot()
    })

    this.proc.onExit((info) => {
      if (this.idleTimer) clearTimeout(this.idleTimer)
      this.emitSnapshot()
      for (const l of this.exitListeners) l(info)
      this.screen.dispose()
    })
  }

  private scheduleSnapshot(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.emitSnapshot(), this.idleMs)
  }

  private emitSnapshot(): void {
    this.idleTimer = null
    const snap = this.screen.snapshot()
    for (const l of this.snapshotListeners) l(snap)
  }

  get pid(): number {
    return this.proc.pid
  }

  get isRunning(): boolean {
    return this.proc.isRunning
  }

  write(data: string): void {
    this.proc.write(data)
  }

  resize(cols: number, rows: number): void {
    this.proc.resize(cols, rows)
    this.screen.resize(cols, rows)
  }

  interrupt(): void {
    this.proc.interrupt()
  }

  kill(): void {
    this.proc.kill()
  }

  onRawData(cb: (chunk: string) => void): () => void {
    this.rawListeners.add(cb)
    return () => this.rawListeners.delete(cb)
  }

  onSnapshot(cb: (snapshot: ScreenSnapshot) => void): () => void {
    this.snapshotListeners.add(cb)
    return () => this.snapshotListeners.delete(cb)
  }

  onExit(cb: (info: ProcessExitInfo) => void): () => void {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }
}

export function createTerminalSessionController(
  command: string,
  args: string[],
  options: SpawnOptions,
  idleMs: number = DEFAULT_IDLE_MS
): TerminalSessionController {
  return new TerminalSessionControllerImpl(command, args, options, idleMs)
}
