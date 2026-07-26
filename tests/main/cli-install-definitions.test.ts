import { describe, expect, it } from 'vitest'
import { getInstallDefinition } from '../../src/main/services/cli-install-definitions'

describe('cli-install-definitions', () => {
  it('Claude Code: the officially documented npm global install', () => {
    const def = getInstallDefinition('claude-code')
    expect(def.supported).toBe(true)
    expect(def.packageManagerCommand).toBe('npm')
    expect(def.installArgs).toEqual(['install', '-g', '@anthropic-ai/claude-code'])
    expect(def.requiresAdmin).toBe(false)
  })

  it('Codex: the officially documented npm global install', () => {
    const def = getInstallDefinition('codex')
    expect(def.supported).toBe(true)
    expect(def.packageManagerCommand).toBe('npm')
    expect(def.installArgs).toEqual(['install', '-g', '@openai/codex'])
    expect(def.requiresAdmin).toBe(false)
  })

  it('Antigravity: automatic install is deliberately unsupported — no confirmed official scriptable method, never a guessed one', () => {
    const def = getInstallDefinition('antigravity')
    expect(def.supported).toBe(false)
    expect(def.installArgs).toEqual([])
    expect(def.manualInstructions).toBeTruthy()
  })

  it('every definition\'s manual instructions are agent-specific, non-empty text', () => {
    for (const id of ['claude-code', 'codex', 'antigravity'] as const) {
      expect(getInstallDefinition(id).manualInstructions.length).toBeGreaterThan(10)
    }
  })
})
