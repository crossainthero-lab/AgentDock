// Real, no-mock capture of claude/codex/agy interactive PTY output. See
// capture-cli-output.js for why this must run under ELECTRON_RUN_AS_NODE.
//
// Usage (via `node scripts/capture-cli-output.js <scratchRoot> [agentFilter]`):
//   scratchRoot   — absolute path to a disposable directory (created if
//                   missing); each scenario gets its own fresh subdirectory
//                   under it so first-run/workspace-trust prompts are real.
//   agentFilter   — optional: 'claude-code' | 'codex' | 'antigravity' to
//                   capture just one agent instead of all three.
//
// A brand-new scratch directory means the very first screen from every one
// of these CLIs is its own workspace-trust/onboarding prompt, not the actual
// reply — so this auto-advances past up to MAX_AUTO_ADVANCE such prompts by
// sending a bare Enter (every observed trust prompt's own footer literally
// says "Press enter to continue", or highlights the affirmative option by
// default) before treating a settled screen as the real captured result.
const pty = require('node-pty')
const fs = require('node:fs')
const path = require('node:path')

const IDLE_SETTLE_MS = 5000 // consider the screen "settled" after this much quiet
const HARD_TIMEOUT_MS = 90000 // force-finalize even if it never goes idle
const MAX_AUTO_ADVANCE = 3

const scratchRoot = process.argv[2]
const agentFilter = process.argv[3] || null

if (!scratchRoot) {
  console.error('usage: capture-cli-output-impl.js <scratchRoot> [agentFilter]')
  process.exit(1)
}

const REPLY_PROMPT = 'Reply with exactly: HELLO CAPTURE TEST. Do not use any tools.'
const PERMISSION_PROMPT = 'Create a file named capture-test.txt containing the word hi.'

// Absolute .exe paths (confirmed via `Get-Command` on this machine) — bare
// command names failed to resolve through node-pty's own spawn/PATH lookup
// even though they resolve fine through a normal shell.
const AGENTS = [
  {
    id: 'claude-code',
    command: 'C:\\Users\\billy\\.local\\bin\\claude.exe',
    buildArgs: (prompt) => ['--ax-screen-reader', prompt]
  },
  {
    id: 'codex',
    command: 'C:\\Users\\billy\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe',
    buildArgs: (prompt, cwd) => ['--no-alt-screen', '-C', cwd, prompt]
  },
  {
    id: 'antigravity',
    command: 'C:\\Users\\billy\\AppData\\Local\\agy\\bin\\agy.exe',
    buildArgs: (prompt) => ['-i', prompt]
  }
]

const SCENARIOS = [
  { name: 'reply', prompt: REPLY_PROMPT },
  { name: 'permission', prompt: PERMISSION_PROMPT }
]

// Heuristic for "this settled screen is itself a trust/onboarding prompt,
// not the real result yet" — every onboarding prompt observed on this
// machine so far literally contains one of these phrases.
const ONBOARDING_PATTERNS = [/press enter to continue/i, /do you trust/i, /trust the contents/i, /trust this folder/i]

function looksLikeOnboarding(text) {
  return ONBOARDING_PATTERNS.some((p) => p.test(text))
}

function captureOne(agent, scenario) {
  return new Promise((resolve) => {
    const cwd = path.join(scratchRoot, agent.id, scenario.name)
    fs.mkdirSync(cwd, { recursive: true })

    const args = agent.buildArgs(scenario.prompt, cwd)
    console.log(`\n=== capturing ${agent.id}/${scenario.name} — ${agent.command} ${JSON.stringify(args)} (cwd=${cwd}) ===`)

    let raw = '' // full transcript, every byte ever received
    let sinceAdvance = '' // just since the last auto-advance keystroke, for the onboarding check
    let idleTimer = null
    let hardTimer = null
    let finished = false
    let advanceCount = 0

    let proc
    try {
      proc = pty.spawn(agent.command, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd,
        env: process.env,
        useConpty: true
      })
    } catch (err) {
      console.error(`[capture] failed to spawn ${agent.command}: ${err.message}`)
      resolve({ agent: agent.id, scenario: scenario.name, raw: '', error: String(err) })
      return
    }

    function finalize(reason) {
      if (finished) return
      finished = true
      if (idleTimer) clearTimeout(idleTimer)
      if (hardTimer) clearTimeout(hardTimer)
      console.log(`[capture] ${agent.id}/${scenario.name} settled (${reason}), ${raw.length} bytes captured, ${advanceCount} auto-advance(s)`)
      try {
        proc.kill()
      } catch {
        // already dead
      }
      const outFile = path.join(scratchRoot, `${agent.id}-${scenario.name}.raw.log`)
      fs.writeFileSync(outFile, raw, 'utf8')
      resolve({ agent: agent.id, scenario: scenario.name, raw, outFile })
    }

    function onIdle() {
      if (finished) return
      if (advanceCount < MAX_AUTO_ADVANCE && looksLikeOnboarding(sinceAdvance)) {
        advanceCount += 1
        console.log(`[capture] ${agent.id}/${scenario.name}: looks like onboarding/trust prompt #${advanceCount}, sending Enter to advance`)
        sinceAdvance = ''
        proc.write('\r')
        scheduleIdle()
        return
      }
      finalize('idle')
    }

    function scheduleIdle() {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(onIdle, IDLE_SETTLE_MS)
    }

    hardTimer = setTimeout(() => finalize('hard-timeout'), HARD_TIMEOUT_MS)

    proc.onData((chunk) => {
      raw += chunk
      sinceAdvance += chunk
      scheduleIdle()
    })

    proc.onExit(({ exitCode, signal }) => {
      console.log(`[capture] ${agent.id}/${scenario.name} process exited on its own (exitCode=${exitCode}, signal=${signal ?? 'none'})`)
      finalize('process-exit')
    })
  })
}

async function main() {
  fs.mkdirSync(scratchRoot, { recursive: true })
  const agents = agentFilter ? AGENTS.filter((a) => a.id === agentFilter) : AGENTS
  if (agents.length === 0) {
    console.error(`no matching agent for filter "${agentFilter}"`)
    process.exit(1)
  }

  const results = []
  for (const agent of agents) {
    for (const scenario of SCENARIOS) {
      // eslint-disable-next-line no-await-in-loop
      const result = await captureOne(agent, scenario)
      results.push(result)
    }
  }

  console.log('\n=== capture summary ===')
  for (const r of results) {
    console.log(`${r.agent}/${r.scenario}: ${r.error ? `ERROR ${r.error}` : `${r.outFile} (${r.raw.length} bytes)`}`)
  }
}

main().then(() => process.exit(0))
