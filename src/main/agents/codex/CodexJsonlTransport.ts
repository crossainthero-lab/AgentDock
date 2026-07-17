// Owns argv construction and process lifecycle for one Codex turn. One
// instance = one `codex exec ...` invocation = one turn. `codex exec` has
// no persistent-stdin protocol at all (confirmed via `codex exec --help`
// and `codex exec resume --help`) — continuation is exclusively via
// `codex exec resume <thread_id> "<prompt>"`, which is exactly the
// process-per-turn shape this transport already uses for turn 1.
import { childProcessService, type ManagedChildProcess, type ProcessExitInfo } from '../../services/child-process-service'

export interface CodexTransportOptions {
  cwd: string
  /** One of capability-registry's codex permissionModes ids ('default' |
   *  'read-only' | 'workspace-write' | 'danger-full-access' | 'bypass'). */
  permissionMode: string
  /** Real Codex thread_id captured from a prior turn's `thread.started`
   *  event, or null for the first turn. */
  nativeThreadId: string | null
  /** Pending model id requested via setModel() for this turn, if any. */
  modelId: string | null
}

function sandboxArgs(permissionMode: string): string[] {
  switch (permissionMode) {
    case 'bypass':
      return ['--dangerously-bypass-approvals-and-sandbox']
    case 'read-only':
    case 'workspace-write':
    case 'danger-full-access':
      return ['--sandbox', permissionMode]
    default:
      return []
  }
}

export class CodexJsonlTransport {
  private proc: ManagedChildProcess | null = null
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly exitListeners = new Set<(info: ProcessExitInfo) => void>()

  constructor(private readonly executablePath: string, private readonly options: CodexTransportOptions) {}

  get pid(): number | undefined {
    return this.proc?.pid
  }

  start(prompt: string): void {
    const args: string[] = this.options.nativeThreadId
      ? ['exec', 'resume', this.options.nativeThreadId, prompt, '--json']
      : ['exec', prompt, '--json', '-C', this.options.cwd]
    args.push(...sandboxArgs(this.options.permissionMode))
    if (this.options.modelId) {
      args.push('--model', this.options.modelId)
    }

    const redacted = args.map((a) => (a === prompt ? '<prompt>' : a))
    console.log(`[codex] launching structured turn, args (prompt redacted): ${JSON.stringify(redacted)}`)
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
