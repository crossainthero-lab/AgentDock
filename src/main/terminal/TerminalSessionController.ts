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
  /** Fires at most once every BUSY_THROTTLE_MS while raw PTY data keeps
   *  arriving — independent of the idle-debounced snapshot above. A fast,
   *  continuously-redrawing spinner (confirmed against real captured Codex/
   *  Antigravity "thinking" output) never goes idle long enough to produce
   *  a snapshot, so without this a live "still working" signal could never
   *  fire for the entire duration of a long thinking phase. Adapters use
   *  this only as a generic fallback "Working" signal until a real
   *  classified activity/tool_activity event arrives — see
   *  agents/shared/conflict-integration.ts. */
  onBusy(cb: () => void): () => void
  onExit(cb: (info: ProcessExitInfo) => void): () => void
}

const DEFAULT_IDLE_MS = 450
const BUSY_THROTTLE_MS = 1200

class TerminalSessionControllerImpl implements TerminalSessionController {
  private readonly proc: ManagedProcess
  private readonly screen: TerminalScreenBuffer
  private readonly rawListeners = new Set<(chunk: string) => void>()
  private readonly snapshotListeners = new Set<(snapshot: ScreenSnapshot) => void>()
  private readonly busyListeners = new Set<() => void>()
  private readonly exitListeners = new Set<(info: ProcessExitInfo) => void>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private lastBusyEmitMs = 0

  constructor(command: string, args: string[], options: SpawnOptions, private readonly idleMs: number) {
    this.screen = new TerminalScreenBuffer(options.cols ?? 120, options.rows ?? 30)
    this.proc = ptyService.spawn(command, args, options)

    this.proc.onData((chunk) => {
      this.screen.write(chunk)
      for (const l of this.rawListeners) l(chunk)
      this.scheduleSnapshot()
      this.maybeEmitBusy()
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

  private maybeEmitBusy(): void {
    const now = Date.now()
    if (now - this.lastBusyEmitMs < BUSY_THROTTLE_MS) return
    this.lastBusyEmitMs = now
    for (const l of this.busyListeners) l()
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

  onBusy(cb: () => void): () => void {
    this.busyListeners.add(cb)
    return () => this.busyListeners.delete(cb)
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
