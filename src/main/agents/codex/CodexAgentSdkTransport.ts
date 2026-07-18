// Thin wrapper around the official `@openai/codex-sdk`. Replaces the old
// hand-rolled `codex exec --json` spawn (CodexJsonlTransport, now deleted)
// which had a fatal bug: Node's default `child_process.spawn` stdio leaves
// the child's stdin open as an unclosed pipe, and Codex — even when given
// the prompt as a positional CLI argument — always first tries to read and
// append piped stdin as a `<stdin>` block before proceeding. With nothing
// ever writing to or closing that pipe, the process hung forever and never
// emitted a single event (confirmed empirically: `thread.started` never
// even arrived). This is the exact, sole cause of AgentDock's Codex
// sessions getting permanently stuck on "Codex is working".
//
// The SDK gets this right — it writes the prompt to stdin and immediately
// calls `.end()` on it (verified by reading its compiled source) — so
// adopting it instead of re-deriving the same fix by hand also removes an
// entire class of transport bugs (line-buffering, argv construction,
// resume-id bookkeeping) that were hand-maintained before.
//
// The SDK package is ESM-only (`"type": "module"`) while AgentDock's main
// process builds to CJS — same situation as ClaudeAgentSdkTransport, same
// fix: only types are imported statically (erased at compile time), the
// runtime module is loaded via a cached dynamic `import()`.
import type { Codex as CodexClass, SandboxMode, Thread, ThreadEvent, ThreadOptions } from '@openai/codex-sdk'

type CodexSdkModule = typeof import('@openai/codex-sdk')

let sdkModulePromise: Promise<CodexSdkModule> | null = null
function loadSdk(): Promise<CodexSdkModule> {
  if (!sdkModulePromise) sdkModulePromise = import('@openai/codex-sdk')
  return sdkModulePromise
}

export interface CodexAgentSdkTransportOptions {
  cwd: string
  executablePath: string
  /** AgentDock's own codex permissionModes id ('default' | 'read-only' |
   *  'workspace-write' | 'danger-full-access' | 'bypass'). */
  permissionMode: string
  nativeThreadId: string | null
}

export interface TransportExitInfo {
  errored: boolean
  reason?: string
}

// The SDK's ThreadOptions.sandboxMode only accepts the CLI's three real
// `--sandbox` values — there is no SDK-level equivalent of the CLI's
// dedicated `--dangerously-bypass-approvals-and-sandbox` flag (confirmed:
// absent from both the SDK's public types and its compiled source). The
// closest honest equivalent achievable through the SDK is
// danger-full-access (no sandbox restriction) combined with
// approvalPolicy:'never' below — not byte-for-byte identical to the CLI
// flag, but functionally equivalent for AgentDock's purposes.
const SANDBOX_MODE_MAP: Record<string, SandboxMode | undefined> = {
  default: undefined,
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  'danger-full-access': 'danger-full-access',
  bypass: 'danger-full-access'
}

/** One per AgentDock Codex session. `codex exec` has no persistent-stdin
 *  protocol (confirmed via `codex exec --help`) — every turn is still its
 *  own process under the hood — but the SDK's `Thread` object tracks the
 *  captured thread_id internally and automatically resumes on each
 *  subsequent `runStreamed()` call, so keeping one Thread alive for a
 *  session's whole lifetime (rather than reconstructing resume bookkeeping
 *  by hand) is both correct and simpler. */
export class CodexAgentSdkTransport {
  private codex: CodexClass | null = null
  private thread: Thread | null = null
  private running = false
  private abortController: AbortController | null = null
  private readonly messageListeners = new Set<(msg: ThreadEvent) => void>()
  // A Thread only supports one active runStreamed() call at a time.
  // Confirmed empirically against the real SDK: calling runStreamed()
  // again immediately after the previous turn's terminal event
  // (turn.completed) — a completely normal "send a quick follow-up"
  // pattern — races the still-finishing previous call. Chaining every
  // start() through this promise ensures a turn's real runStreamed() call
  // never begins until the previous turn's launch() has fully settled
  // (success or failure), not merely once its last event was observed.
  private launchChain: Promise<TransportExitInfo> = Promise.resolve({ errored: false })

  constructor(private readonly opts: CodexAgentSdkTransportOptions) {}

  get isRunning(): boolean {
    return this.running
  }

  get threadId(): string | null {
    return this.thread?.id ?? null
  }

  onMessage(cb: (msg: ThreadEvent) => void): () => void {
    this.messageListeners.add(cb)
    return () => this.messageListeners.delete(cb)
  }

  /** Starts (queuing behind any still-finishing previous turn — see
   *  launchChain) exactly one turn, resolving with that turn's own result
   *  once it alone has ended. Deliberately a one-shot return value per
   *  call rather than a persistent broadcast listener: an earlier design
   *  used a shared onExit(Set) that every call added a listener to, and
   *  the transport notified ALL of them on every completion — so a
   *  quick follow-up message sent right after a turn finished would have
   *  its listener already registered by the time the *previous* turn's
   *  trailing exit fired, and that turn's own listener would spuriously
   *  claim the previous turn's (unrelated) clean-exit signal as its own.
   *  Confirmed via a real live run against the actual Codex CLI: a
   *  same-session follow-up produced a fabricated turn_exited for the new
   *  turn moments before its real reply arrived. A dedicated promise per
   *  call makes that cross-talk structurally impossible. */
  start(prompt: string): Promise<TransportExitInfo> {
    this.running = true
    const result = this.launchChain.then(() => this.launch(prompt))
    this.launchChain = result
    return result
  }

  private async launch(prompt: string): Promise<TransportExitInfo> {
    try {
      const { Codex } = await loadSdk()
      if (!this.codex) {
        this.codex = new Codex({ codexPathOverride: this.opts.executablePath })
      }
      if (!this.thread) {
        const threadOptions: ThreadOptions = {
          workingDirectory: this.opts.cwd,
          skipGitRepoCheck: true,
          // `codex exec`/the SDK's JSON mode has no human present to answer
          // an approval prompt — 'never' reports sandbox denials straight
          // back to the model (which can retry a different way, same as
          // the CLI's own documented behavior) instead of risking the
          // process waiting on an approval that can never arrive.
          approvalPolicy: 'never',
          sandboxMode: SANDBOX_MODE_MAP[this.opts.permissionMode]
        }
        this.thread = this.opts.nativeThreadId
          ? this.codex.resumeThread(this.opts.nativeThreadId, threadOptions)
          : this.codex.startThread(threadOptions)
      }

      this.abortController = new AbortController()
      const { events } = await this.thread.runStreamed(prompt, { signal: this.abortController.signal })
      for await (const event of events) {
        for (const listener of this.messageListeners) listener(event)
      }
      this.running = false
      return { errored: false }
    } catch (err) {
      this.running = false
      const reason = err instanceof Error ? err.message : String(err)
      console.error(`[codex-sdk] thread run ended with an error: ${reason}`)
      return { errored: true, reason }
    }
  }

  /** Aborts the in-flight turn's process (Node forwards AbortSignal to a
   *  SIGTERM on the child — confirmed via the SDK's compiled source). The
   *  Thread object itself stays alive so a later `start()` can continue
   *  the same conversation. */
  interrupt(): void {
    this.abortController?.abort()
  }

  /** Ends the session for good. */
  stop(): void {
    this.abortController?.abort()
    this.thread = null
  }
}
