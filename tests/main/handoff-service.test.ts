// Uses the REAL database/repositories (an in-memory sql.js instance backed
// by a disposable temp userData dir) rather than mocking them out — the bug
// this file verifies (recursive handoff-envelope duplication across a real
// multi-hop chain) only actually shows up against genuine persisted
// message history, the same way it did in the real reported incident. Only
// `electron` (for app.getPath) and sessionService.sendPrompt (the actual
// process-spawning side effect, irrelevant to what's being verified here)
// are stubbed.
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
import { sessionService } from '../../src/main/services/session-service'
import { handoffService } from '../../src/main/services/handoff-service'

describe('handoffService — root-cause fix for recursive continuation duplication', () => {
  let workspaceId: string
  let sendPromptSpy: ReturnType<typeof vi.spyOn>
  let lastSentPrompt: string | null

  beforeEach(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'agentdock-handoff-'))
    await initDatabase()
    workspaceId = workspaceRepo.upsert('C:\\project-pulse', 'Project Pulse').id
    lastSentPrompt = null
    sendPromptSpy = vi.spyOn(sessionService, 'sendPrompt').mockImplementation(async (sessionId, text) => {
      lastSentPrompt = text
      // Mirrors the real sendPrompt's own first side effect (persisting the
      // prompt as this session's own first message) — everything after
      // that (spawning a real adapter) is what's being stubbed out.
      messageRepo.add(sessionId, 'user', { kind: 'text', text })
    })
  })

  afterEach(() => {
    closeDatabase()
    vi.restoreAllMocks()
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
      const codexSession = await handoffService.execute({
        sourceSessionId: claudeSession.id,
        destinationAgentId: 'codex',
        summary: claudeSummary,
        additionalInstruction: 'add local persistence'
      })
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
      const antigravitySession = await handoffService.execute({
        sourceSessionId: codexSession.id,
        destinationAgentId: 'antigravity',
        summary: codexSummary,
        additionalInstruction: 'add reset dashboard'
      })
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

  it("the user's new instruction appears exactly once in the prompt actually delivered to the destination agent", async () => {
    const source = sessionRepo.create(workspaceId, 'claude-code', 'Build login', 'generated')
    messageRepo.add(source.id, 'user', { kind: 'text', text: 'Build login' })
    messageRepo.add(source.id, 'assistant', { kind: 'text', text: 'Done.' })

    await handoffService.execute({
      sourceSessionId: source.id,
      destinationAgentId: 'antigravity',
      summary: handoffService.generateSummary(source.id),
      additionalInstruction: 'add password reset'
    })

    expect(sendPromptSpy).toHaveBeenCalledTimes(1)
    expect(lastSentPrompt).not.toBeNull()
    const occurrences = lastSentPrompt!.match(/add password reset/gi)?.length ?? 0
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
    expect(summary).toContain('Issues encountered:')
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

    const next = await handoffService.execute({
      sourceSessionId: source.id,
      destinationAgentId: 'codex',
      summary: handoffService.generateSummary(source.id),
      additionalInstruction: ''
    })

    expect(next.title).toBe('Add reset dashboard (continued)')
  })
})
