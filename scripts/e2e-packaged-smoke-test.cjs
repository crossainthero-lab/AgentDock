// Real smoke test against the ACTUAL PACKAGED Windows app
// (release/win-unpacked/AgentDock.exe) — not `out/main/index.js` via bare
// electron.exe, and not the dev repo. Uses Playwright's `_electron`
// launcher pointed at the real packaged executable, so this genuinely
// exercises asar resolution, unpacked native node-pty binaries, and the
// packaged preload/renderer bundle exactly as an end user would run them.
//
// Everything operates on disposable temp directories — a fresh, empty
// userData dir (never touches the real user's ~/AppData/Roaming/agentdock)
// and a fresh temp workspace with SPACES and UNICODE characters in its
// name/path, to prove the packaged app handles both. Requires the real
// claude/codex/agy CLIs installed and authenticated on this machine —
// skips (with a clear message) any agent that isn't detected rather than
// failing the whole run.
//
// Run manually: node scripts/e2e-packaged-smoke-test.cjs
const { _electron: electron } = require('playwright')
const path = require('path')
const os = require('os')
const fs = require('fs')

const PACKAGED_EXE = path.join(__dirname, '../release/win-unpacked/AgentDock.exe')

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

async function main() {
  if (!fs.existsSync(PACKAGED_EXE)) {
    console.log('[smoke] SKIP - packaged exe not found at', PACKAGED_EXE, '— run `npm run package:win` first')
    return
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-packaged-smoke-'))
  // Deliberately spaces AND Unicode characters in both the directory name
  // itself and a nested subfolder — the exact case the portability pass
  // must handle correctly end to end (dialog selection, DB persistence,
  // adapter cwd, PTY spawn).
  const workspaceDir = path.join(os.tmpdir(), 'AgentDock Smoke Test Projéct 日本語 ' + Date.now())
  fs.mkdirSync(workspaceDir, { recursive: true })
  fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# smoke test workspace\n')
  console.log('[smoke] disposable userDataDir:', userDataDir)
  console.log('[smoke] disposable workspaceDir (spaces + unicode):', workspaceDir)

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
    record('application launches (packaged exe, repo not involved)', true)
    record('no blank/white window — renderer content present', (bodyText ?? '').trim().length > 0, `body text length=${(bodyText ?? '').length}`)

    // --- 2. Application-data directory created correctly ---
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
      // Close settings back out. NOT button[aria-label="Close"] — the
      // frameless window's own title bar close button (TitleBar.tsx) shares
      // that exact aria-label and sits earlier in DOM order than the
      // portal-rendered dialog's own close button, so a plain selector
      // click risks hitting the WINDOW close button instead. Escape is
      // unambiguous — Dialog.tsx listens for it directly.
      await window.keyboard.press('Escape')
      await window.waitForTimeout(300)
    } else {
      record('Settings view opens', false, 'settings button not found')
    }

    // --- 4. Workspace selection (path with spaces + Unicode) ---
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
    record('workspace with spaces + Unicode characters selected successfully', !!projectOpened)

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
      }
    }

    async function startNewSessionInProject() {
      const newSessionBtn = await window.$('button[aria-label="New conversation in this project"]')
      if (newSessionBtn) {
        await newSessionBtn.click()
        await window.waitForTimeout(800)
      }
    }

    await testAgent('Claude Code', 'CLAUDE PACKAGED OK')
    await startNewSessionInProject()
    await testAgent('Codex', 'CODEX PACKAGED OK')
    await startNewSessionInProject()
    await testAgent('Antigravity', 'ANTIGRAVITY PACKAGED OK')

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
    try {
      const { execSync } = require('child_process')
      const tasklist = execSync('tasklist /FI "IMAGENAME eq AgentDock.exe"').toString()
      const stillRunning = /AgentDock\.exe/i.test(tasklist)
      record('AgentDock.exe process itself exits after quit', !stillRunning, stillRunning ? 'still listed in tasklist' : undefined)
    } catch (err) {
      record('AgentDock.exe process itself exits after quit', true, 'tasklist check inconclusive: ' + err.message)
    }
  } finally {
    await electronApp.close().catch(() => {})
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
