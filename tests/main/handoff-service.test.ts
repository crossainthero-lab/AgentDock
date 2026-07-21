// Uses the REAL database/repositories (an in-memory sql.js instance backed
// by a disposable temp userData dir) rather than mocking them out — the bug
// this file verifies (recursive handoff-envelope duplication across a real
// multi-hop chain) only actually shows up against genuine persisted
// message history, the same way it did in the real reported incident.
//
// CRITICAL: handoffService.execute() deliberately never sends the new
// session's first prompt itself anymore (see handoff-service.ts's module
// comment — that used to invent a turnId the renderer's reducer never
// learned, which is the confirmed root cause of a continued session's
// response rendering blank). It only creates the session and returns the
// prompt text; the real caller (HandoffDialog) sends it through
// conversationStore.sendPrompt(), which is what actually persists it as
// the new session's first user message. These tests simulate that one
// real side effect (messageRepo.add of the returned prompt) themselves,
// via sendAsIfFromRenderer() below, so excludeHandoffEnvelope's behavior
// against genuine persisted history is still exercised faithfully.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? userDataDir : tmpdir()) }
}))

import { initDatabase, closeDatabase } from '../../src/main/db/database'
import { workspaceRepo } from '../../src/main/db/repositories/workspace-repo'
import { sessionRepo } from '../../src/main/db/repositories/session-repo'
import { messageRepo } from '../../src/main/db/repositories/message-repo'
import { handoffService } from '../../src/main/services/handoff-service'
import type { HandoffExecuteResult } from '../../src/shared/types'

describe('handoffService — root-cause fix for recursive continuation duplication', () => {
  let workspaceId: string

  /** Mirrors conversationStore.sendPrompt's real first side effect
   *  (persisting the prompt as the new session's own first message) —
   *  everything after that (spawning a real adapter) is irrelevant here. */
  function sendAsIfFromRenderer(result: HandoffExecuteResult): HandoffExecuteResult {
    messageRepo.add(result.session.id, 'user', { kind: 'text', text: result.prompt })
    return result
  }

  beforeEach(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'agentdock-handoff-'))
    await initDatabase()
    workspaceId = workspaceRepo.upsert('C:\\project-pulse', 'Project Pulse').id
  })

  afterEach(() => {
    closeDatabase()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('generateSummary describes a first-hop session cleanly, with no duplicate request listing', () => {
    const a = sessionRepo.create(workspaceId, 'claude-code', 'Build login', 'generated')
    messageRepo.add(a.id, 'user', { kind: 'text', text: 'Add a login page' })
    messageRepo.add(a.id, 'assistant', {
      kind: 'activity',
      tool: 'Write',
      summary: 'Wrote login.tsx',
      detail: 'Write(src/login.tsx)',
      isError: false
    })
    messageRepo.add(a.id, 'assistant', { kind: 'text', text: 'I added a login page.' })

    const summary = handoffService.generateSummary(a.id)

    expect(summary).toContain('Add a login page')
    expect(summary).toContain('Continuing from a Claude Code conversation')
    expect(summary.match(/Add a login page/g)?.length).toBe(1)
    expect(summary).toContain('Workspace: C:\\project-pulse')
  })

  it(
    'CRITICAL (real bug fix): a 3-hop chain (Claude -> Codex -> Antigravity) never re-embeds an ' +
      "earlier hop's envelope, request list, or action list into a later hop's summary",
    async () => {
      // --- Hop 1: Claude, the real original conversation ---
      const claudeSession = sessionRepo.create(workspaceId, 'claude-code', 'Build Project Pulse', 'generated')
      messageRepo.add(claudeSession.id, 'user', { kind: 'text', text: 'Build Project Pulse' })
      messageRepo.add(claudeSession.id, 'assistant', {
        kind: 'activity',
        tool: 'Write',
        summary: 'Wrote app.tsx',
        detail: 'Write(src/app.tsx)',
        isError: false
      })
      messageRepo.add(claudeSession.id, 'assistant', { kind: 'text', text: 'Project Pulse scaffolding is in place.' })

      // --- Hop 2: hand off to Codex ---
      const claudeSummary = handoffService.generateSummary(claudeSession.id)
      const { session: codexSession } = sendAsIfFromRenderer(
        await handoffService.execute({
          sourceSessionId: claudeSession.id,
          destinationAgentId: 'codex',
          summary: claudeSummary,
          additionalInstruction: 'add local persistence'
        })
      )
      expect(codexSession.continuedFromSessionId).toBe(claudeSession.id)
      expect(codexSession.titleSource).toBe('handoff')
      expect(codexSession.title).toBe('Add local persistence (continued)')
      // Codex's own genuine work on top of the injected envelope (message 0).
      messageRepo.add(codexSession.id, 'assistant', {
        kind: 'activity',
        tool: 'Write',
        summary: 'Wrote persistence.ts',
        detail: 'Write(src/persistence.ts)',
        isError: false
      })
      messageRepo.add(codexSession.id, 'assistant', { kind: 'text', text: 'Local persistence added.' })

      const codexSummary = handoffService.generateSummary(codexSession.id)
      // The envelope Codex received (Claude's own summary text) must be
      // excluded — none of Claude's own request text leaks back out here.
      expect(codexSummary).not.toContain('Build Project Pulse')
      expect(codexSummary).not.toContain('Wrote app.tsx')
      // Exactly one provenance line describing THIS hop only, never a
      // second nested "Continuing from" for the grandparent hop.
      expect(codexSummary.match(/Continuing from/g)?.length).toBe(1)
      expect(codexSummary).toContain('Continuing from a Codex conversation')

      // --- Hop 3: hand off to Antigravity ---
      const { session: antigravitySession } = sendAsIfFromRenderer(
        await handoffService.execute({
          sourceSessionId: codexSession.id,
          destinationAgentId: 'antigravity',
          summary: codexSummary,
          additionalInstruction: 'add reset dashboard'
        })
      )
      expect(antigravitySession.continuedFromSessionId).toBe(codexSession.id)
      expect(antigravitySession.title).toBe('Add reset dashboard (continued)')
      messageRepo.add(antigravitySession.id, 'assistant', { kind: 'text', text: 'Reset dashboard added.' })

      const antigravitySummary = handoffService.generateSummary(antigravitySession.id)
      // Neither ancestor's content survives into the 3rd hop's summary —
      // this is the exact reported failure (Codex's full action list and
      // Claude's original request recursively duplicated for Antigravity).
      expect(antigravitySummary).not.toContain('Build Project Pulse')
      expect(antigravitySummary).not.toContain('add local persistence')
      expect(antigravitySummary).not.toContain('Wrote persistence.ts')
      expect(antigravitySummary.match(/Continuing from/g)?.length).toBe(1)
      // Bounded regardless of how deep the chain goes — no unbounded growth.
      expect(antigravitySummary.length).toBeLessThan(2000)
    }
  )

  it("the user's new instruction appears exactly once in the prompt returned for the destination agent", async () => {
    const source = sessionRepo.create(workspaceId, 'claude-code', 'Build login', 'generated')
    messageRepo.add(source.id, 'user', { kind: 'text', text: 'Build login' })
    messageRepo.add(source.id, 'assistant', { kind: 'text', text: 'Done.' })

    const { prompt } = await handoffService.execute({
      sourceSessionId: source.id,
      destinationAgentId: 'antigravity',
      summary: handoffService.generateSummary(source.id),
      additionalInstruction: 'add password reset'
    })

    const occurrences = prompt.match(/add password reset/gi)?.length ?? 0
    expect(occurrences).toBe(1)
  })

  it('does not rename or mutate the source session', async () => {
    const source = sessionRepo.create(workspaceId, 'claude-code', 'Build login', 'generated')
    messageRepo.add(source.id, 'user', { kind: 'text', text: 'Build login' })
    const beforeMessages = messageRepo.listBySession(source.id).length

    await handoffService.execute({
      sourceSessionId: source.id,
      destinationAgentId: 'codex',
      summary: handoffService.generateSummary(source.id),
      additionalInstruction: 'continue it'
    })

    const after = sessionRepo.get(source.id)!
    expect(after.title).toBe('Build login')
    expect(after.titleSource).toBe('generated')
    expect(messageRepo.listBySession(source.id).length).toBe(beforeMessages)
  })

  it('extracts real changed files from structured activity data without inventing any', () => {
    const session = sessionRepo.create(workspaceId, 'claude-code', 'Refactor', 'generated')
    messageRepo.add(session.id, 'user', { kind: 'text', text: 'Refactor the parser' })
    messageRepo.add(session.id, 'assistant', {
      kind: 'activity',
      tool: 'apply_patch',
      summary: 'Updated 2 files',
      detail: 'apply_patch',
      isError: false,
      richDetail: {
        kind: 'file_change',
        changes: [
          { path: 'src/parser.ts', kind: 'update' },
          { path: 'src/parser.test.ts', kind: 'add' }
        ]
      }
    })

    const summary = handoffService.generateSummary(session.id)
    expect(summary).toContain('Files changed:')
    expect(summary).toContain('src/parser.ts')
    expect(summary).toContain('src/parser.test.ts')
  })

  it('surfaces real errored activity as issues, without fabricating any', () => {
    const session = sessionRepo.create(workspaceId, 'claude-code', 'Build', 'generated')
    messageRepo.add(session.id, 'user', { kind: 'text', text: 'Run the tests' })
    messageRepo.add(session.id, 'assistant', {
      kind: 'activity',
      tool: 'Bash',
      summary: 'npm test failed',
      detail: 'Bash(npm test)',
      isError: true
    })

    const summary = handoffService.generateSummary(session.id)
    expect(summary).toContain('Unresolved issues:')
    expect(summary).toContain('npm test failed')
  })

  it('CRITICAL: payload-size protection caps an unusually large summary even after a huge action list', () => {
    const session = sessionRepo.create(workspaceId, 'claude-code', 'Big task', 'generated')
    messageRepo.add(session.id, 'user', { kind: 'text', text: 'Do a lot of things' })
    for (let i = 0; i < 200; i++) {
      messageRepo.add(session.id, 'assistant', {
        kind: 'activity',
        tool: 'Write',
        summary: `Wrote file number ${i} with a moderately long description of what changed in this specific file`,
        detail: `Write(src/file-${i}.ts)`,
        isError: false
      })
    }

    const summary = handoffService.generateSummary(session.id)
    expect(summary.length).toBeLessThanOrEqual(4200) // MAX_SUMMARY_CHARS + truncation-note slack
    expect(summary).toContain('…and')
  })

  it('falls back to a title derived from the source conversation when no additional instruction is given', async () => {
    const source = sessionRepo.create(workspaceId, 'claude-code', 'Add reset dashboard', 'generated')
    messageRepo.add(source.id, 'user', { kind: 'text', text: 'Add reset dashboard' })

    const { session: next } = await handoffService.execute({
      sourceSessionId: source.id,
      destinationAgentId: 'codex',
      summary: handoffService.generateSummary(source.id),
      additionalInstruction: ''
    })

    expect(next.title).toBe('Add reset dashboard (continued)')
  })

  describe('malformed/duplicated handoff prompt — real bug fix', () => {
    /** Builds the exact final string a receiving agent would see — the
     *  same construction HandoffDialog performs (instruction + generated
     *  summary), letting these tests assert on the ACTUAL prompt text
     *  delivered to the CLI, not just the summary fragment. */
    async function buildHandoffPrompt(sourceSessionId: string, destinationAgentId: 'claude-code' | 'codex' | 'antigravity', instruction: string) {
      const summary = handoffService.generateSummary(sourceSessionId)
      const result = await handoffService.execute({ sourceSessionId, destinationAgentId, summary, additionalInstruction: instruction })
      return sendAsIfFromRenderer(result)
    }

    function countOccurrences(haystack: string, needle: string): number {
      return haystack.split(needle).length - 1
    }

    it('repeated identical tool actions (e.g. a retried failing command) are collapsed into one bullet with a count, never dumped verbatim N times', () => {
      const session = sessionRepo.create(workspaceId, 'codex', 'Fix build', 'generated')
      messageRepo.add(session.id, 'user', { kind: 'text', text: 'Fix the build' })
      for (let i = 0; i < 4; i++) {
        messageRepo.add(session.id, 'assistant', {
          kind: 'activity',
          tool: 'Bash',
          summary: 'Bash failed',
          detail: 'Bash(npm run build)',
          isError: true
        })
      }
      messageRepo.add(session.id, 'assistant', { kind: 'activity', tool: 'Bash', summary: 'Ran npm run build', detail: 'Bash(npm run build)', isError: false })

      const summary = handoffService.generateSummary(session.id)
      expect(countOccurrences(summary, 'Bash failed')).toBe(1)
      expect(summary).toContain('Bash failed (failed 4 times)')
    })

    it('the current task (new instruction) appears exactly once, and the continuation header appears exactly once, in the final prompt sent to the destination agent', async () => {
      const claudeSession = sessionRepo.create(workspaceId, 'claude-code', 'Add activity log', 'generated')
      messageRepo.add(claudeSession.id, 'user', { kind: 'text', text: 'Create activity-log.txt' })
      messageRepo.add(claudeSession.id, 'assistant', { kind: 'text', text: 'Done — created activity-log.txt.' })

      const { session: codexSession, prompt: codexPrompt } = await buildHandoffPrompt(
        claudeSession.id,
        'codex',
        'Append three status lines to activity-log.txt, one per PowerShell check.'
      )

      expect(countOccurrences(codexPrompt, 'Append three status lines to activity-log.txt')).toBe(1)
      expect(countOccurrences(codexPrompt, '--- Continuation context ---')).toBe(1)
      expect(countOccurrences(codexPrompt, 'Workspace:')).toBe(1)
      // The current task must never reappear AFTER the continuation block
      // (the exact reported failure shape: request, prior response, request
      // again, continuation block again).
      const contextIndex = codexPrompt.indexOf('--- Continuation context ---')
      const taskIndexAfterContext = codexPrompt.indexOf('Append three status lines to activity-log.txt', contextIndex + 1)
      expect(taskIndexAfterContext).toBe(-1)

      messageRepo.add(codexSession.id, 'assistant', {
        kind: 'activity',
        tool: 'Edit',
        summary: 'Ran Add-Content activity-log.txt',
        detail: 'Add-Content activity-log.txt',
        isError: false
      })
      messageRepo.add(codexSession.id, 'assistant', { kind: 'text', text: 'Appended the three status lines.' })

      const { prompt: antigravityPrompt } = await buildHandoffPrompt(codexSession.id, 'antigravity', 'Add a final "Log complete." line.')

      expect(countOccurrences(antigravityPrompt, 'Add a final "Log complete." line.')).toBe(1)
      expect(countOccurrences(antigravityPrompt, '--- Continuation context ---')).toBe(1)
      expect(countOccurrences(antigravityPrompt, 'Workspace:')).toBe(1)
      // Never re-embeds the FIRST hop's own content (Claude's original ask)
      // — proves the whole prompt isn't being duplicated end to end either.
      expect(countOccurrences(antigravityPrompt, 'Create activity-log.txt')).toBe(0)
    })

    it('changed files appear exactly once even when the same file is touched by several activities', () => {
      const session = sessionRepo.create(workspaceId, 'codex', 'Edit config', 'generated')
      messageRepo.add(session.id, 'user', { kind: 'text', text: 'Update config.json twice' })
      messageRepo.add(session.id, 'assistant', {
        kind: 'activity',
        tool: 'Edit',
        summary: 'Ran Edit(config.json)',
        detail: 'Edit(config.json)',
        isError: false,
        richDetail: { kind: 'file_change', changes: [{ path: 'config.json', kind: 'update' }] }
      })
      messageRepo.add(session.id, 'assistant', {
        kind: 'activity',
        tool: 'Edit',
        summary: 'Ran Edit(config.json) again',
        detail: 'Edit(config.json)',
        isError: false,
        richDetail: { kind: 'file_change', changes: [{ path: 'config.json', kind: 'update' }] }
      })

      const summary = handoffService.generateSummary(session.id)
      const filesLine = summary.split('\n').find((l) => l.startsWith('Files changed:'))
      expect(filesLine).toBeDefined()
      // The file itself is listed once in the Files changed: line, even
      // though two separate activities touched it (deduplicated by path,
      // not merely truncated) — a real distinct action bullet describing
      // each edit may still separately mention the same filename, which is
      // not a duplication bug.
      expect(filesLine?.match(/config\.json/g)?.length).toBe(1)
    })

    it('keeps overall prompt length reasonable even with many distinct actions and a long response', async () => {
      const session = sessionRepo.create(workspaceId, 'codex', 'Big refactor', 'generated')
      messageRepo.add(session.id, 'user', { kind: 'text', text: 'Refactor the whole module' })
      for (let i = 0; i < 30; i++) {
        messageRepo.add(session.id, 'assistant', {
          kind: 'activity',
          tool: 'Edit',
          summary: `Ran Edit(src/file-${i}.ts)`,
          detail: `Edit(src/file-${i}.ts)`,
          isError: false
        })
      }
      messageRepo.add(session.id, 'assistant', { kind: 'text', text: 'x'.repeat(2000) })

      const { prompt } = await handoffService.execute({
        sourceSessionId: session.id,
        destinationAgentId: 'antigravity',
        summary: handoffService.generateSummary(session.id),
        additionalInstruction: 'Continue'
      })

      // Bounded regardless of how much raw activity/response text the
      // source session accumulated — never an unbounded dump.
      expect(prompt.length).toBeLessThan(5000)
    })
  })
})
