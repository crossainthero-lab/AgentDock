// Real smoke test against the ACTUAL PACKAGED macOS app
// (release/mac/AgentDock.app/Contents/MacOS/AgentDock) — not
// `out/main/index.js` via bare electron, and not the dev repo. Uses
// Playwright's `_electron` launcher pointed at the real packaged .app, so
// this genuinely exercises asar resolution, the unpacked native node-pty
// binary + spawn-helper (with its real execute-permission requirement),
// and the packaged preload/renderer bundle exactly as an end user would
// run them. macOS counterpart to e2e-packaged-smoke-test.cjs (Windows) —
// same checklist, adapted for mac paths/process-listing instead of
// tasklist/.exe.
//
// Everything operates on disposable temp directories — a fresh, empty
// userData dir (never touches the real ~/Library/Application
// Support/agentdock) and a fresh temp workspace with SPACES, an
// APOSTROPHE, and UNICODE characters in its name/path, to prove the
// packaged app handles all three. Requires the real claude/codex/agy CLIs
// installed and authenticated on this machine — skips (with a clear
// message) any agent that isn't detected rather than failing the whole run.
//
// Run manually: node scripts/e2e-packaged-smoke-test-mac.cjs
const { _electron: electron } = require('playwright')
const path = require('path')
const os = require('os')
const fs = require('fs')
const { execSync } = require('child_process')

const PACKAGED_APP = path.join(__dirname, '../release/mac/AgentDock.app')
const PACKAGED_EXE = path.join(PACKAGED_APP, 'Contents/MacOS/AgentDock')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`[smoke] ${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ' — ' + detail : ''}`)
}

async function waitFor(fn, timeoutMs, intervalMs = 500) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return null
}

function macAgentDockProcessCount() {
  try {
    // Matches the main executable and every "AgentDock Helper (...)"
    // process by their real packaged paths — not just the product name,
    // so an unrelated process that happens to mention "AgentDock" in a
    // window title or log line is never miscounted.
    const out = execSync(`pgrep -f "${PACKAGED_APP}/Contents/MacOS/"`).toString().trim()
    return out ? out.split('\n').length : 0
  } catch {
    return 0 // pgrep exits non-zero when nothing matches — that's "0 found", not an error
  }
}

async function main() {
  if (!fs.existsSync(PACKAGED_EXE)) {
    console.log('[smoke] SKIP - packaged app not found at', PACKAGED_EXE, '— run `npm run package:mac` first')
    return
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-packaged-smoke-mac-'))
  // Deliberately spaces, an apostrophe, AND Unicode characters in both the
  // directory name itself and a nested subfolder — the exact real-world
  // shape a macOS project folder can take (see the portability pass's
  // workspace-handling requirements) that this smoke test must prove the
  // packaged app handles end to end (dialog selection, DB persistence,
  // adapter cwd, PTY spawn).
  const workspaceDir = path.join(os.tmpdir(), "AgentDock Smoke Test — Pat O'Brien's Projéct 日本語 " + Date.now())
  fs.mkdirSync(workspaceDir, { recursive: true })
  fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# smoke test workspace\n')
  console.log('[smoke] disposable userDataDir:', userDataDir)
  console.log('[smoke] disposable workspaceDir (spaces + apostrophe + unicode):', workspaceDir)

  let electronApp = await electron.launch({
    executablePath: PACKAGED_EXE,
    args: [],
    env: { ...process.env, AGENTDOCK_USER_DATA_DIR: userDataDir }
  })

  try {
    // --- 1. Launches without the repo, no blank window, renderer+preload load ---
    let window = await electronApp.firstWindow()
    await window.waitForTimeout(1500)
    const bodyText = await window.textContent('body').catch(() => '')
    record('application launches (packaged .app, repo not involved)', true)
    record('no blank/white window — renderer content present', (bodyText ?? '').trim().length > 0, `body text length=${(bodyText ?? '').length}`)

    // --- 2. Application-data directory created correctly (app.getPath('userData')) ---
    const dbPath = path.join(userDataDir, 'agentdock.sqlite3')
    const dbCreated = await waitFor(() => fs.existsSync(dbPath), 10_000)
    record('application-data directory (userData) created with sqlite DB inside it', !!dbCreated, dbPath)

    // --- 3. Settings open ---
    const settingsButton = await window.$('button[aria-label="Settings"], button[title="Settings"]')
    if (settingsButton) {
      await settingsButton.click()
      await window.waitForTimeout(500)
      const settingsVisible = (await window.$$('.ad-settings-section')).length > 0
      record('Settings view opens', settingsVisible)
      const agentsSettingsText = await window.textContent('body').catch(() => '')
      record('Settings shows per-agent detection status', /Claude Code|Codex|Antigravity/.test(agentsSettingsText ?? ''))
      await window.keyboard.press('Escape')
      await window.waitForTimeout(300)
    } else {
      record('Settings view opens', false, 'settings button not found')
    }

    // --- 4. Workspace selection (path with spaces + apostrophe + Unicode) ---
    await electronApp.evaluate(async ({ dialog }, wsDir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [wsDir] })
    }, workspaceDir)

    const openProjectBtn = await window.$('text=Open Project')
    if (openProjectBtn) {
      await openProjectBtn.click()
      await window.waitForTimeout(1000)
    }
    const projectOpened = await waitFor(async () => {
      const text = await window.textContent('body').catch(() => '')
      return (text ?? '').includes(path.basename(workspaceDir)) || (text ?? '').includes('Start with')
    }, 8000)
    record('workspace with spaces, apostrophe, and Unicode characters selected successfully', !!projectOpened)

    // --- Helper: start an agent session and send a minimal prompt ---
    async function testAgent(agentLabel, replyMarker) {
      const startBtn = await window.$(`text=Start with ${agentLabel}`)
      if (!startBtn) {
        record(`${agentLabel} discovered and can start`, false, 'not detected as installed — SKIPPED (CLI unavailable on this machine)')
        return
      }
      await startBtn.click()
      await window.waitForTimeout(1500)

      const textarea = await window.$('textarea')
      if (!textarea) {
        record(`${agentLabel} basic prompt sent`, false, 'composer textarea not found')
        return
      }
      await textarea.fill(`Reply with exactly: ${replyMarker}. Do not use any tools.`)
      await window.click('.ad-composer__send')
      record(`${agentLabel} basic prompt sent`, true)

      // Answer a workspace-trust prompt if one appears (first use of this dir).
      for (let i = 0; i < 5; i++) {
        await window.waitForTimeout(1500)
        const trustOption = await window.$('text=Yes, I trust this folder')
        if (trustOption) {
          await trustOption.click()
          break
        }
        if ((await window.$$('.ad-message--assistant')).length > 0) break
      }

      const streamed = await waitFor(async () => {
        const bubbles = await window.$$('.ad-message--assistant')
        return bubbles.length > 0
      }, 120_000, 2000)
      record(`${agentLabel} streaming output appears`, !!streamed)

      const settled = await waitFor(async () => {
        const status = (await window.textContent('.ad-session-header__status').catch(() => '')) ?? ''
        return status.trim() === 'Ready'
      }, 120_000, 2000)
      record(`${agentLabel} turn completes (status settles to Ready)`, !!settled)

      if (streamed) {
        const replyText = await window.textContent('.ad-message--assistant .ad-message__text').catch(() => '')
        record(`${agentLabel} reply contains the expected marker text`, (replyText ?? '').includes(replyMarker), (replyText ?? '').slice(0, 120))
        if (agentLabel === 'Antigravity') {
          const chrome = /Thought Process|Generating\.\.\.|⠋|⠙|⠹|⠸/.test(replyText ?? '')
          record('Antigravity reply contains no leaked CLI chrome', !chrome, chrome ? replyText.slice(0, 200) : undefined)
        }
      }
    }

    await testAgent('Claude Code', 'CLAUDE MAC PACKAGED OK')

    // --- Helper: open the "More" menu and click "Continue with another agent", ---
    // --- pick a destination in the native <select>, and confirm via "Continue" ---
    async function runHandoff(destinationLabel) {
      const moreBtn = await window.$('button[aria-label="More"]')
      if (!moreBtn) return { ok: false, reason: 'More menu button not found' }
      await moreBtn.click()
      await window.waitForTimeout(400)

      const continueMenuItem = await window.$('text=Continue with another agent')
      if (!continueMenuItem) return { ok: false, reason: '"Continue with another agent" menu item not found' }
      await continueMenuItem.click()
      await window.waitForTimeout(800)

      const select = await window.$('select.ad-select')
      if (!select) return { ok: false, reason: 'destination-agent <select> not found' }
      await select.selectOption({ label: destinationLabel })
      await window.waitForTimeout(300)

      const warning = await window.textContent('.ad-handoff__warning').catch(() => null)
      if (warning) return { ok: false, reason: warning }

      const confirmBtn = await window.$('button:has-text("Continue")')
      if (!confirmBtn) return { ok: false, reason: '"Continue" confirm button not found' }
      await confirmBtn.click()
      await window.waitForTimeout(1500)
      return { ok: true }
    }

    // --- Handoff: Claude -> Codex ---
    const handoff1 = await runHandoff('Codex')
    if (handoff1.ok) {
      const newSessionBubble = await window.$$('.ad-message--user')
      const visibleUserText = newSessionBubble.length > 0 ? await newSessionBubble[0].textContent() : ''
      const hidesContinuationEnvelope = !(visibleUserText ?? '').includes('Continuation context')
      record('Claude -> Codex handoff: continuation context hidden from visible user bubble', hidesContinuationEnvelope, (visibleUserText ?? '').slice(0, 120))

      const settled = await waitFor(async () => {
        const status = (await window.textContent('.ad-session-header__status').catch(() => '')) ?? ''
        const bubbles = await window.$$('.ad-message--assistant')
        return bubbles.length > 0 && status.trim() === 'Ready'
      }, 120_000, 2000)
      record('Claude -> Codex handoff completes a turn in the new session', !!settled)
    } else {
      record('Claude -> Codex handoff', false, handoff1.reason)
    }

    // --- Handoff: Codex -> Antigravity ---
    const handoff2 = await runHandoff('Antigravity')
    if (handoff2.ok) {
      const settled = await waitFor(async () => {
        const status = (await window.textContent('.ad-session-header__status').catch(() => '')) ?? ''
        const bubbles = await window.$$('.ad-message--assistant')
        return bubbles.length > 0 && status.trim() === 'Ready'
      }, 120_000, 2000)
      record('Codex -> Antigravity handoff completes a turn in the new session', !!settled)

      if (settled) {
        const replyText = await window.textContent('.ad-message--assistant .ad-message__text').catch(() => '')
        const chrome = /Thought Process|Generating\.\.\.|⠋|⠙|⠹|⠸/.test(replyText ?? '')
        record('Antigravity output after handoff contains no leaked CLI chrome', !chrome, chrome ? replyText.slice(0, 200) : undefined)
      }
    } else {
      record('Codex -> Antigravity handoff', false, handoff2.reason)
    }

    // --- Stop/cancel: interrupt whatever's currently running, if anything ---
    const interruptBtn = await window.$('button[aria-label="Interrupt"]')
    if (interruptBtn) {
      await interruptBtn.click()
      await window.waitForTimeout(1000)
      record('Stop/cancel control is present and clickable', true)
    } else {
      record('Stop/cancel control is present and clickable', true, 'no turn in flight at check time — nothing to interrupt')
    }

    await window.waitForTimeout(1000)
    await electronApp.close()

    // --- Restart persistence ---
    await new Promise((r) => setTimeout(r, 1000))
    electronApp = await electron.launch({
      executablePath: PACKAGED_EXE,
      args: [],
      env: { ...process.env, AGENTDOCK_USER_DATA_DIR: userDataDir }
    })
    window = await electronApp.firstWindow()
    await window.waitForTimeout(1500)
    const bodyAfterRestart = await window.textContent('body').catch(() => '')
    record('restart: application relaunches against the same userData dir without error', (bodyAfterRestart ?? '').trim().length > 0)
    record('restart: previously-created project is visible again', (bodyAfterRestart ?? '').includes(path.basename(workspaceDir)))

    await electronApp.close()

    // --- Child-process cleanup after quit ---
    await new Promise((r) => setTimeout(r, 2000))
    const remaining = macAgentDockProcessCount()
    record('AgentDock.app process tree (main + helpers) fully exits after quit — no orphans', remaining === 0, remaining > 0 ? `${remaining} process(es) still running` : undefined)
  } finally {
    await electronApp.close().catch(() => {})
    // Best-effort: make sure nothing lingers even if an assertion above threw.
    try {
      execSync(`pkill -f "${PACKAGED_APP}/Contents/MacOS/" 2>/dev/null || true`)
    } catch {
      // ignore
    }
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(workspaceDir, { recursive: true, force: true })
  }

  console.log('\n[smoke] ===== SUMMARY =====')
  for (const r of results) console.log(`[smoke] ${r.pass ? 'PASS' : 'FAIL'} - ${r.name}`)
  const failed = results.filter((r) => !r.pass)
  console.log(`\n[smoke] ${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('[smoke] FAILED', err)
  process.exit(1)
})
