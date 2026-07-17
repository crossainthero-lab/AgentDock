// Owns argv construction and process lifecycle for one Claude turn. One
// instance = one `claude -p ...` invocation = one turn — process-per-turn,
// not a persistent stdin pipe (see plan: interrupt = kill the process,
// mirrors Codex, avoids a long-lived-pipe's error-recovery complexity).
//
// `--input-format stream-json` is deliberately NOT used: it exists for a
// persistent multi-turn stdin protocol, which this transport doesn't use.
// The prompt is passed as the positional argument (verified working live,
// including across multiple `--resume`d turns) — simpler and just as
// capable for a one-shot-per-turn design.
import { childProcessService, type ManagedChildProcess, type ProcessExitInfo } from '../../services/child-process-service'

export interface ClaudeTransportOptions {
  cwd: string
  /** One of capability-registry's claude permissionModes ids ('default' |
   *  'acceptEdits' | 'plan' | 'bypassPermissions'). */
  permissionMode: string
  /** Real Claude session_id captured from a prior turn's `system init`
   *  event, or null for the first turn. */
  nativeSessionId: string | null
  /** Pending model id requested via setModel() for this turn, if any. */
  modelId: string | null
}

export class ClaudeStreamJsonTransport {
  private proc: ManagedChildProcess | null = null
  // Owned independently of `proc` so onLine()/onExit() can be called any
  // time relative to start() (the adapter wires listeners before starting
  // the process, so events can never race a not-yet-attached listener).
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly exitListeners = new Set<(info: ProcessExitInfo) => void>()

  constructor(private readonly executablePath: string, private readonly options: ClaudeTransportOptions) {}

  get pid(): number | undefined {
    return this.proc?.pid
  }

  start(prompt: string): void {
    const args: string[] = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
    if (this.options.permissionMode !== 'default') {
      args.push('--permission-mode', this.options.permissionMode)
    }
    if (this.options.modelId) {
      args.push('--model', this.options.modelId)
    }
    if (this.options.nativeSessionId) {
      args.push('--resume', this.options.nativeSessionId)
    }

    const redacted = [args[0], '<prompt>', ...args.slice(2)]
    console.log(`[claude] launching structured turn, args (prompt redacted): ${JSON.stringify(redacted)}`)
    this.proc = childProcessService.spawn(this.executablePath, args, { cwd: this.options.cwd })
    this.proc.onLine((line) => {
      for (const listener of this.lineListeners) listener(line)
    })
    this.proc.onExit((info) => {
      for (const listener of this.exitListeners) listener(info)
    })
  }

  onLine(cb: (line: string) => void): () => void {
    this.lineListeners.add(cb)
    return () => this.lineListeners.delete(cb)
  }

  onExit(cb: (info: ProcessExitInfo) => void): () => void {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }

  kill(): void {
    this.proc?.kill()
  }

  get isRunning(): boolean {
    return this.proc?.isRunning ?? false
  }
}
