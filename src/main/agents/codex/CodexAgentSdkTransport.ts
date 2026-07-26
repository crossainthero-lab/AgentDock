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
import type { Codex as CodexClass, Input, SandboxMode, Thread, ThreadEvent, ThreadOptions, UserInput } from '@openai/codex-sdk'
import { isWindowsShim, resolveShimTarget } from '../../services/windows-shim-resolver'
import { buildSpawnDiagnostics, formatSpawnDiagnostics } from '../../services/spawn-diagnostics'

type CodexSdkModule = typeof import('@openai/codex-sdk')

let sdkModulePromise: Promise<CodexSdkModule> | null = null
function loadSdk(): Promise<CodexSdkModule> {
  if (!sdkModulePromise) sdkModulePromise = import('@openai/codex-sdk')
  return sdkModulePromise
}

// @openai/codex-sdk calls raw `child_process.spawn(this.executablePath,
// commandArgs, {...})` internally (confirmed by reading its compiled
// source) with no shell option and no Windows `.cmd`/`.bat` awareness —
// unlike @anthropic-ai/claude-agent-sdk, it exposes no override hook to
// substitute a safer spawn mechanism. A `.cmd`/`.bat`-resolved Codex
// install (the normal shape produced by e.g. `npm install -g`, as opposed
// to a native .exe from Codex's own Windows installer) handed to it as
// `codexPathOverride` fails with `spawn <path> EINVAL` the moment a
// session actually starts.
//
// The real fix (see codex-runtime-resolver.ts's module comment for the
// full priority order) is upstream of this file: `this.opts.executablePath`
// is now ALWAYS a verified, real, directly-spawnable native executable —
// never a PATH-resolved `codex.cmd` shim — regardless of which tier
// resolved it (a user-configured custom path, the Codex SDK's own bundled
// runtime, or an official standalone install).
//
// codexPathOverride is deliberately ALWAYS passed now, even for the
// default 'sdk-bundled' case. An earlier version of this fix tried to
// leave codexPathOverride unset for 'sdk-bundled' specifically, letting
// `new Codex({})` resolve its own bundled runtime internally — the
// natural reading of "don't force an override when nothing was
// explicitly configured." That approach was verified against a REAL
// packaged build and found to be broken: the SDK's own internal
// `findCodexPath()` does the exact same `require.resolve()`-based vendor
// lookup this file's resolver mirrors, and inside a packaged Electron app
// that lookup returns a path that LOOKS like it exists (Electron patches
// `fs.existsSync`/`statSync` to transparently redirect reads of an
// asar-unpacked file) but cannot actually be spawned directly — raw
// `child_process.spawn`/Windows `CreateProcess` bypass Electron's patched
// fs layer entirely and need the real `app.asar.unpacked` path.
// codex-runtime-resolver.ts's `resolveSdkBundledExecutablePath` already
// converts that logical path to its real unpacked equivalent (see its own
// `toRealUnpackedPath` doc comment) — but the SDK's OWN internal
// resolution has no equivalent fix and never will, since AgentDock can't
// patch third-party compiled code. Passing our own already-corrected path
// as `codexPathOverride` is the only way to actually get a packaged
// session to launch. The one thing this trades away is the SDK's own
// `pathDirs` behavior (prepending its bundled ripgrep directory onto the
// child's PATH when it self-resolves) — a minor capability loss, not a
// launch failure, and the child still inherits AgentDock's own full
// environment either way (see `CodexOptions.env`'s own default-to-inherit
// behavior in the SDK's compiled source).
//
// `resolveCodexExecutablePath` below is kept as a last-resort defense: if
// `executablePath` somehow still turns out to be a `.cmd`/`.bat` shim
// (e.g. a pre-fix saved custom path that hasn't been re-validated yet),
// this still tries to resolve it to a directly-executable target rather
// than handing the SDK something already known not to work, and fails
// loudly with a clear, actionable error if it can't.
function resolveCodexExecutablePath(executablePath: string): string {
  if (!isWindowsShim(executablePath)) return executablePath
  const target = resolveShimTarget(executablePath)
  if (target && target.args.length === 0) return target.command

  const error = new Error(
    `Codex resolved to a Windows shim (${executablePath}) that AgentDock cannot launch directly — the Codex SDK has no way to run it through cmd.exe. ` +
      'Locate the real codex.exe (commonly under %LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin) and set it as a custom path in Settings → Agents, or reinstall Codex using its native Windows installer instead of npm.'
  )
  const diagnostics = buildSpawnDiagnostics({
    agentId: 'codex',
    mechanism: 'sdk-spawn (codexPathOverride)',
    executablePath,
    error
  })
  console.error('[codex-sdk] shim resolution failed:', formatSpawnDiagnostics(diagnostics))
  throw new Error(`${error.message}\n\n${formatSpawnDiagnostics(diagnostics)}`)
}

export interface CodexAgentSdkTransportOptions {
  cwd: string
  executablePath: string
  /** How `executablePath` was resolved (see AgentRunContext's own doc
   *  comment) — carried through for diagnostics/logging only. Every
   *  source ('custom', 'sdk-bundled', 'standalone') results in
   *  `codexPathOverride` being passed to the SDK (see this file's module
   *  comment for exactly why 'sdk-bundled' isn't special-cased to omit
   *  it): by construction, `executablePath` is always a verified, real,
   *  directly-spawnable native executable by the time it reaches here,
   *  never a PATH-resolved shim. */
  executablePathSource?: 'custom' | 'sdk-bundled' | 'standalone'
  /** AgentDock's own codex permissionModes id ('default' | 'read-only' |
   *  'workspace-write' | 'danger-full-access' | 'bypass'). */
  permissionMode: string
  nativeThreadId: string | null
  /** One of the live model catalogue's ids (see
   *  codex-model-catalog-service.ts), or null/undefined to let Codex use
   *  its own configured default (~/.codex/config.toml) — never guessed. */
  model?: string | null
  /** One of the selected model's own supportedReasoningEfforts ids from
   *  the same live catalogue — e.g. "ultra" — or null/undefined to let
   *  Codex use that model's own defaultReasoningEffort. Deliberately typed
   *  as a plain string, not the SDK's own `ModelReasoningEffort` union
   *  ("minimal"|"low"|"medium"|"high"|"xhigh"): that union is stale
   *  relative to the real catalogue, which already returns values like
   *  "max" and "ultra" it doesn't know about. Confirmed safe by reading
   *  the SDK's compiled source — it forwards this value verbatim into
   *  `--config model_reasoning_effort="<value>"` with no runtime
   *  validation against the union, and a real turn with "ultra" was
   *  confirmed to run successfully. */
  modelReasoningEffort?: string | null
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
  // Async-capable: CodexAdapter's listener needs to `await` a response-image
  // directory scan before turn.completed is mapped/emitted (so the resulting
  // response_artifacts event lands while the turn is still active — see
  // codex-response-image-service.ts and CodexAdapter's handleMessage). The
  // launch() loop below awaits each listener call in order, so this is safe
  // even though there's only ever one real listener in practice.
  private readonly messageListeners = new Set<(msg: ThreadEvent) => void | Promise<void>>()
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

  onMessage(cb: (msg: ThreadEvent) => void | Promise<void>): () => void {
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
  /** `images` are absolute paths already saved into this session's
   *  persistent attachment storage (see codex-attachment-service.ts) —
   *  turned into `{type:'local_image', path}` UserInput entries, Codex's
   *  real native image-input mechanism (confirmed by reading the SDK's
   *  compiled source: these become real `--image <path>` flags on the
   *  underlying `codex exec` invocation, not embedded base64 text). */
  start(prompt: string, images?: string[]): Promise<TransportExitInfo> {
    this.running = true
    const result = this.launchChain.then(() => this.launch(prompt, images))
    this.launchChain = result
    return result
  }

  private async launch(prompt: string, images?: string[]): Promise<TransportExitInfo> {
    try {
      const { Codex } = await loadSdk()
      if (!this.codex) {
        // Always pass codexPathOverride — see this file's module comment
        // for exactly why 'sdk-bundled' isn't special-cased to omit it
        // (verified against a real packaged build: the SDK's own internal
        // self-resolution has no equivalent to
        // codex-runtime-resolver.ts's app.asar.unpacked path correction).
        this.codex = new Codex({ codexPathOverride: resolveCodexExecutablePath(this.opts.executablePath) })
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
          sandboxMode: SANDBOX_MODE_MAP[this.opts.permissionMode],
          model: this.opts.model ?? undefined,
          // Cast past the SDK's stale narrow union — see this field's doc
          // comment in CodexAgentSdkTransportOptions above.
          modelReasoningEffort: (this.opts.modelReasoningEffort ?? undefined) as ThreadOptions['modelReasoningEffort']
        }
        this.thread = this.opts.nativeThreadId
          ? this.codex.resumeThread(this.opts.nativeThreadId, threadOptions)
          : this.codex.startThread(threadOptions)
      }

      this.abortController = new AbortController()
      const input: Input =
        images && images.length > 0
          ? [{ type: 'text', text: prompt }, ...images.map((path): UserInput => ({ type: 'local_image', path }))]
          : prompt
      const { events } = await this.thread.runStreamed(input, { signal: this.abortController.signal })
      for await (const event of events) {
        // Sequential await, not Promise.all — a listener that needs to act
        // before the NEXT event is processed (e.g. scanning for generated
        // images before turn.completed is mapped) depends on this ordering.
        for (const listener of this.messageListeners) await listener(event)
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

  /** Changes the model for the next turn without losing conversation
   *  history. There's no per-turn model override in the SDK (ThreadOptions
   *  is only read when a Thread is created) — but discarding the cached
   *  Thread wrapper and letting the next launch() recreate it via
   *  resumeThread(realThreadId, {model}) is confirmed equivalent to `codex
   *  exec resume <id> -m <model>`, which genuinely continues the same
   *  thread under the new model (the CLI only warns that the session was
   *  recorded under a different model — it doesn't restart or drop
   *  history). A no-op while a turn is actively running; the new model
   *  takes effect starting the next start() call. */
  setModel(model: string | null): void {
    if (this.opts.model === model) return
    this.opts.model = model
    this.discardCachedThreadForNextTurn()
  }

  /** Same mechanism as setModel() — a separate control, but the same
   *  "Thread only reads options at creation" constraint applies. */
  setReasoningEffort(reasoningEffort: string | null): void {
    if (this.opts.modelReasoningEffort === reasoningEffort) return
    this.opts.modelReasoningEffort = reasoningEffort
    this.discardCachedThreadForNextTurn()
  }

  private discardCachedThreadForNextTurn(): void {
    if (this.thread && !this.running) {
      if (this.thread.id) this.opts.nativeThreadId = this.thread.id
      this.thread = null
    }
  }
}
