// Thin wrapper around the official `@anthropic-ai/claude-agent-sdk`'s
// `query()`. One instance backs one AgentDock session for its whole
// lifetime (not one per turn) — the SDK's `canUseTool`/`interrupt()`/
// `setModel()`/`setPermissionMode()` are only meaningful in *streaming
// input* mode, which requires a single long-lived Query fed via a pushed
// async iterable rather than a fresh one-shot prompt string per turn.
//
// The SDK package is ESM-only (`"type": "module"`, `main: "sdk.mjs"`)
// while AgentDock's main process builds to CJS (electron-vite's default
// main output, confirmed by the `"use strict"` header in out/main/index.js)
// — a top-level `import` of it would compile to a `require()` that throws
// ERR_REQUIRE_ESM. It's loaded via a cached dynamic `import()` instead;
// only types are imported statically (erased at compile time, never
// reach runtime as a require call).
import type { CanUseTool, Options, PermissionMode, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

type ClaudeAgentSdkModule = typeof import('@anthropic-ai/claude-agent-sdk')

let sdkModulePromise: Promise<ClaudeAgentSdkModule> | null = null
function loadSdk(): Promise<ClaudeAgentSdkModule> {
  if (!sdkModulePromise) sdkModulePromise = import('@anthropic-ai/claude-agent-sdk')
  return sdkModulePromise
}

/** Minimal manually-implemented pushable async iterable — the SDK consumes
 *  `prompt` as `AsyncIterable<SDKUserMessage>` and pulls from it for as
 *  long as the Query is alive; `push()` delivers each new AgentDock turn's
 *  prompt into the same live query instead of spawning a new process. */
class PushableAsyncIterable<T> implements AsyncIterable<T> {
  private readonly queue: T[] = []
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiting.shift()
    if (waiter) waiter({ value, done: false })
    else this.queue.push(value)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiting.length > 0) {
      this.waiting.shift()?.({ value: undefined as unknown as T, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) return Promise.resolve({ value: this.queue.shift() as T, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as unknown as T, done: true })
        return new Promise((resolve) => this.waiting.push(resolve))
      }
    }
  }
}

export interface ClaudeAgentSdkTransportOptions {
  cwd: string
  executablePath: string
  /** AgentDock's own permission-mode id — validated/normalized here since
   *  the SDK's PermissionMode union doesn't accept arbitrary strings. */
  permissionMode: string
  nativeSessionId: string | null
  modelId: string | null
  canUseTool: CanUseTool
  env?: NodeJS.ProcessEnv
}

export interface TransportExitInfo {
  /** True when the query stream ended because of a genuine SDK/process
   *  error (as opposed to a clean end-of-turn or an intentional stop()). */
  errored: boolean
  reason?: string
}

const VALID_SDK_PERMISSION_MODES = new Set<PermissionMode>(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'])

function normalizePermissionMode(mode: string): PermissionMode | undefined {
  if (mode === 'default' || mode === '') return undefined // let the CLI's own default apply
  return VALID_SDK_PERMISSION_MODES.has(mode as PermissionMode) ? (mode as PermissionMode) : undefined
}

/** One per AgentDock Claude session. Call `start(prompt)` for the first
 *  turn; every subsequent turn calls `start(prompt)` again — if a Query is
 *  already running it's reused (pushed into), otherwise a fresh one is
 *  created (e.g. resuming after the app restarted). */
export class ClaudeAgentSdkTransport {
  private query: Query | null = null
  private input: PushableAsyncIterable<SDKUserMessage> | null = null
  private running = false
  private readonly messageListeners = new Set<(msg: SDKMessage) => void>()
  private readonly exitListeners = new Set<(info: TransportExitInfo) => void>()

  constructor(private readonly opts: ClaudeAgentSdkTransportOptions) {}

  get isRunning(): boolean {
    return this.running
  }

  onMessage(cb: (msg: SDKMessage) => void): () => void {
    this.messageListeners.add(cb)
    return () => this.messageListeners.delete(cb)
  }

  onExit(cb: (info: TransportExitInfo) => void): () => void {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }

  start(prompt: string): void {
    const userMessage: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      parent_tool_use_id: null
    }

    if (this.query && this.input) {
      this.input.push(userMessage)
      return
    }

    this.input = new PushableAsyncIterable<SDKUserMessage>()
    this.input.push(userMessage)
    this.running = true
    void this.launch()
  }

  private async launch(): Promise<void> {
    try {
      const { query } = await loadSdk()
      const permissionMode = normalizePermissionMode(this.opts.permissionMode)
      const options: Options = {
        cwd: this.opts.cwd,
        pathToClaudeCodeExecutable: this.opts.executablePath,
        permissionMode,
        allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
        model: this.opts.modelId ?? undefined,
        resume: this.opts.nativeSessionId ?? undefined,
        includePartialMessages: true,
        canUseTool: this.opts.canUseTool,
        env: this.opts.env
      }
      this.query = query({ prompt: this.input as PushableAsyncIterable<SDKUserMessage>, options })

      for await (const message of this.query) {
        for (const listener of this.messageListeners) listener(message)
      }
      this.running = false
      for (const listener of this.exitListeners) listener({ errored: false })
    } catch (err) {
      this.running = false
      const reason = err instanceof Error ? err.message : String(err)
      console.error(`[claude-sdk] query stream ended with an error: ${reason}`)
      for (const listener of this.exitListeners) listener({ errored: true, reason })
    }
  }

  /** Cooperative interrupt — asks the SDK to stop the in-flight turn. The
   *  query itself (and its ability to accept another pushed message) stays
   *  alive; only the current turn is cancelled. */
  interrupt(): void {
    this.query?.interrupt().catch((err) => console.warn('[claude-sdk] interrupt() failed', err))
  }

  /** Ends the query for good — closes the input iterable (so the SDK's
   *  read loop terminates) and interrupts any in-flight turn. */
  stop(): void {
    this.input?.close()
    this.query?.interrupt().catch(() => {})
  }

  setModel(modelId: string | undefined): void {
    this.query?.setModel(modelId).catch((err) => console.warn('[claude-sdk] setModel() failed', err))
  }

  setPermissionMode(mode: string): void {
    const normalized = normalizePermissionMode(mode)
    if (!normalized) return
    this.query?.setPermissionMode(normalized).catch((err) => console.warn('[claude-sdk] setPermissionMode() failed', err))
  }
}
