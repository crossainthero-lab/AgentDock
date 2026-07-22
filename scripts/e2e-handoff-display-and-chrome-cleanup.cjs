// Real Electron E2E verification for two fixes, run against the REAL built
// app (Playwright's `_electron` launcher — genuine main process, real IPC,
// real spawned `agy`/`codex` processes) — not a browser mock:
//
//   1. Handoff display: the visible user bubble for a NEW handoff-created
//      session must show only the task the user actually typed, never the
//      internal "--- Continuation context ---" envelope — while the prompt
//      actually delivered to the destination agent still carries the full
//      context.
//   2. Antigravity CLI chrome cleanup: a real Antigravity reply must never
//      contain "Thought Process", "Generating...", spinner glyphs, or other
//      recognized terminal chrome.
//
// Operates entirely on DISPOSABLE COPIES of this machine's real AgentDock
// database and the real "FocusBoard" test project it already references
// (built up across earlier real Claude -> Codex -> Antigravity sessions) —
// never touches the user's actual ~/AppData/Roaming/agentdock data or their
// real Testing Zone project files. Requires:
//   - `npm run build` has been run (launches out/main/index.js directly)
//   - `codex`/`agy` installed and already authenticated on this machine
//   - the real agentdock.sqlite3 + FocusBoard project this script copies
//     from (see REAL_USER_DATA/REAL_WORKSPACE_DIR below) — skips with a
//     clear message if either is missing, rather than failing confusingly
//
// Not part of `npm run test` / CI. Run manually:
//   node scripts/e2e-handoff-display-and-chrome-cleanup.cjs
// Set AGENTDOCK_E2E_PACKAGED=1 to run this same verification against the
// actual PACKAGED build (release/win-unpacked/AgentDock.exe — run
// `npm run package:win` first) instead of dev mode (out/main/index.js) —
// proves the packaged build behaves identically, not just development mode:
//   AGENTDOCK_E2E_PACKAGED=1 node scripts/e2e-handoff-display-and-chrome-cleanup.cjs
const { _electron: electron } = require('playwright')
const path = require('path')
const os = require('os')
const fs = require('fs')
const initSqlJs = require('sql.js')

const REAL_USER_DATA = path.join(process.env.APPDATA || '', 'agentdock')
const REAL_DB = path.join(REAL_USER_DATA, 'agentdock.sqlite3')
const REAL_WORKSPACE_DIR = 'C:\\Users\\billy\\Documents\\Testing Zone\\Testing Run 5'

const PACKAGED_EXE = path.join(__dirname, '../release/win-unpacked/AgentDock.exe')
const usePackaged = process.env.AGENTDOCK_E2E_PACKAGED === '1'

/** Launch options for either dev mode (bare electron.exe + out/main/index.js
 *  as an argv, exactly like `electron-vite dev`'s own launch shape) or the
 *  real packaged build (executablePath pointed straight at AgentDock.exe,
 *  no argv) — the only difference between the two verification modes. */
function launchOptions(userDataDir) {
  const env = { ...process.env, AGENTDOCK_USER_DATA_DIR: userDataDir }
  if (usePackaged) {
    if (!fs.existsSync(PACKAGED_EXE)) {
      throw new Error(`AGENTDOCK_E2E_PACKAGED=1 but no packaged build found at ${PACKAGED_EXE} — run \`npm run package:win\` first`)
    }
    return { executablePath: PACKAGED_EXE, args: [], env }
  }
  return { args: [path.join(__dirname, '../out/main/index.js')], env }
}

const CHROME_PATTERNS = [/Thought Process/i, /Generating\.\.\./i, /Generating…/i, /esc to cancel/i, /\? for shortcuts/i, /Resume with -c/i]
const CONTEXT_SENTINELS = ['--- Continuation context ---', 'Workspace:', 'Prior work completed', 'Files changed:']

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

async function readDb(dbPath) {
  const SQL = await initSqlJs()
  const buf = fs.readFileSync(dbPath)
  return new SQL.Database(buf)
}

function rowsOf(res) {
  if (!res[0]) return []
  return res[0].values.map((row) => Object.fromEntries(res[0].columns.map((c, i) => [c, row[i]])))
}

async function main() {
  if (!fs.existsSync(REAL_DB) || !fs.existsSync(REAL_WORKSPACE_DIR)) {
    console.log('[e2e] SKIP - real agentdock.sqlite3 or FocusBoard project not found on this machine; nothing to verify against')
    return
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-e2e-handoff-'))
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-e2e-handoff-ws-'))
  console.log('[e2e] disposable userDataDir:', userDataDir)
  console.log('[e2e] disposable workspaceDir (copy of real FocusBoard project):', workspaceDir)

  // Disposable copies only — the real files are never opened for writing.
  fs.copyFileSync(REAL_DB, path.join(userDataDir, 'agentdock.sqlite3'))
  copyDir(REAL_WORKSPACE_DIR, workspaceDir)

  // Repoint the copied DB's own workspace row at the copied folder, so the
  // real app operates entirely inside the disposable copy, never the real
  // "Testing Zone" directory on disk.
  {
    const SQL = await initSqlJs()
    const buf = fs.readFileSync(path.join(userDataDir, 'agentdock.sqlite3'))
    const db = new SQL.Database(buf)
    const before = rowsOf(db.exec('SELECT id, path FROM workspaces'))
    if (before.length === 0) {
      console.log('[e2e] SKIP - copied database has no workspace row to repoint')
      return
    }
    for (const w of before) {
      db.run('UPDATE workspaces SET path = @path WHERE id = @id', { '@path': workspaceDir, '@id': w.id })
    }
    fs.writeFileSync(path.join(userDataDir, 'agentdock.sqlite3'), Buffer.from(db.export()))
    console.log('[e2e] repointed workspace path ->', workspaceDir)
  }

  console.log('[e2e] mode:', usePackaged ? `PACKAGED (${PACKAGED_EXE})` : 'dev (out/main/index.js)')
  let electronApp = await electron.launch(launchOptions(userDataDir))

  let newSessionId = null

  try {
    let window = await electronApp.firstWindow()
    await window.waitForTimeout(1500)

    // --- Step: open the real, existing Codex session (the middle hop of
    // the real Claude -> Codex -> Antigravity chain already on disk) and
    // hand off to Antigravity with a genuinely NEW instruction. ---
    const codexRow = await window.$('text=Continue from Claude')
    if (!codexRow) {
      console.log('[e2e] FAIL - could not find the real existing Codex session in the sidebar')
      process.exitCode = 1
      return
    }
    await codexRow.click()
    await window.waitForTimeout(1000)

    const moreButton = await window.$('button[aria-label="More"], button[title="More"]')
    if (!moreButton) {
      console.log('[e2e] FAIL - session header "More" menu button not found')
      process.exitCode = 1
      return
    }
    await moreButton.click()
    await window.waitForTimeout(300)
    await window.click('text=Continue with another agent')
    await window.waitForTimeout(500)

    const destinationSelect = await window.$('.ad-handoff select')
    if (!destinationSelect) {
      console.log('[e2e] FAIL - handoff destination select not found')
      process.exitCode = 1
      return
    }
    await destinationSelect.selectOption('antigravity')
    await window.waitForTimeout(300)

    // Wait for the mechanical summary to finish generating (local, no model
    // call — should be near-instant) before reading it back.
    await window.waitForSelector('.ad-handoff__summary-loading', { state: 'detached', timeout: 10_000 }).catch(() => {})

    const NEW_TASK = 'Add a settings gear icon that toggles between light and dark theme.'
    const textareas = await window.$$('.ad-handoff textarea')
    if (textareas.length < 2) {
      console.log('[e2e] FAIL - expected summary + instruction textareas in the handoff dialog')
      process.exitCode = 1
      return
    }
    const summaryTextBefore = await textareas[0].inputValue()
    console.log('[e2e] generated summary (first 120 chars):', summaryTextBefore.slice(0, 120).replace(/\n/g, ' '))
    await textareas[1].fill(NEW_TASK)

    await window.click('.ad-dialog__footer button:has-text("Continue")')
    await window.waitForTimeout(2000)

    // --- Verify: the new session's visible user bubble is clean. ---
    const userBubbleText = await window.textContent('.ad-message--user .ad-message__text').catch(() => null)
    console.log('[e2e] visible user bubble text:', JSON.stringify(userBubbleText))
    const bubbleClean = userBubbleText === NEW_TASK
    console.log('[e2e]', bubbleClean ? 'PASS' : 'FAIL', '- user bubble shows ONLY the typed task, nothing else')
    for (const sentinel of CONTEXT_SENTINELS) {
      const leaked = (userBubbleText ?? '').includes(sentinel)
      console.log('[e2e]', leaked ? 'FAIL' : 'PASS', `- user bubble does not contain "${sentinel}"`)
    }

    // --- Verify: the RAW prompt actually delivered to Antigravity still
    // has the full continuation context (read directly from the DB this
    // app instance is writing to, right after messageRepo.add persisted it). ---
    {
      const db = await readDb(path.join(userDataDir, 'agentdock.sqlite3'))
      const sessions = rowsOf(db.exec("SELECT id, agent_id, continued_from_session_id, created_at FROM sessions WHERE agent_id = 'antigravity' ORDER BY created_at DESC LIMIT 1"))
      if (sessions.length === 0) {
        console.log('[e2e] FAIL - no antigravity session found after handoff')
        process.exitCode = 1
        return
      }
      newSessionId = sessions[0].id
      const msgs = rowsOf(db.exec(`SELECT content_json FROM messages WHERE session_id = '${newSessionId}' AND role = 'user' ORDER BY created_at ASC LIMIT 1`))
      const content = msgs.length > 0 ? JSON.parse(msgs[0].content_json) : null
      const delivered = content?.text ?? ''
      const display = content?.displayText ?? ''
      console.log('[e2e] persisted displayText:', JSON.stringify(display))
      console.log('[e2e] persisted delivered text contains context:', delivered.includes('--- Continuation context ---'))
      const deliveredHasContext = CONTEXT_SENTINELS.every((s) => delivered.includes(s))
      console.log('[e2e]', deliveredHasContext ? 'PASS' : 'FAIL', '- full continuation context still reaches the delivered prompt (text)')
      console.log('[e2e]', display === NEW_TASK ? 'PASS' : 'FAIL', '- persisted displayText matches the typed task exactly')
    }

    // --- Wait for a real Antigravity reply to complete. A real turn that
    // actually edits files (not just replies with text) has been observed
    // taking well over 4 minutes end to end — generous budget here. ---
    console.log('[e2e] waiting up to 900s for a real Antigravity reply')
    let gotReply = false
    let windowClosed = false
    for (let i = 0; i < 450; i++) {
      await window.waitForTimeout(2000)
      try {
        if ((await window.$$('.ad-interaction-card')).length > 0) {
          await window.click('text=Yes, I trust this folder').catch(() => {})
        }
        const status = (await window.textContent('.ad-session-header__status').catch(() => '')) ?? ''
        const bubbles = await window.$$('.ad-message--assistant')
        if (bubbles.length > 0 && status.trim() === 'Ready') {
          gotReply = true
          break
        }
      } catch (err) {
        // A single flaky poll (e.g. a transient Playwright/window hiccup)
        // must not abort the entire run — only a genuinely closed window
        // does, and that's reported below rather than thrown, so the rest
        // of the script's checks (and its own cleanup) still run.
        if (/closed/i.test(err.message || '')) {
          windowClosed = true
          console.log(`[e2e] window/page closed unexpectedly during poll #${i} — stopping the wait loop early:`, err.message)
          break
        }
      }
    }
    if (windowClosed) {
      console.log('[e2e] FAIL - window stayed open for the duration of the real Antigravity turn (closed unexpectedly mid-turn)')
    }
    console.log('[e2e]', gotReply ? 'PASS' : 'FAIL (or slow/rate-limited)', '- real Antigravity reply rendered and turn settled to Ready')

    if (gotReply) {
      await window.waitForTimeout(1000)
      const assistantText = await window.textContent('.ad-message--assistant .ad-message__text').catch(() => '')
      console.log('[e2e] assistant reply (first 200 chars):', (assistantText ?? '').slice(0, 200).replace(/\n/g, ' '))
      for (const pattern of CHROME_PATTERNS) {
        const leaked = pattern.test(assistantText ?? '')
        console.log('[e2e]', leaked ? 'FAIL' : 'PASS', `- assistant reply does not contain chrome matching ${pattern}`)
      }
    }

    await electronApp.close().catch(() => {})

    // --- Restart AgentDock (relaunch against the SAME disposable userData
    // dir) — the user bubble and the assistant reply must both stay clean. ---
    electronApp = await electron.launch(launchOptions(userDataDir))
    window = await electronApp.firstWindow()
    await window.waitForTimeout(1500)

    const reopenRow = await window.$(`text=${NEW_TASK.slice(0, 30)}`).catch(() => null)
    const antigravityRow = reopenRow ?? (await window.$('text=Settings gear').catch(() => null))
    if (antigravityRow) {
      await antigravityRow.click()
      await window.waitForTimeout(1000)
    } else {
      console.log('[e2e] (could not locate the new session by title after restart — trying the most recent session row)')
    }

    const bubbleAfterRestart = await window.textContent('.ad-message--user .ad-message__text').catch(() => null)
    console.log('[e2e] user bubble after restart:', JSON.stringify(bubbleAfterRestart))
    console.log('[e2e]', bubbleAfterRestart === NEW_TASK ? 'PASS' : 'FAIL', '- user bubble stays clean after an AgentDock restart')

    const assistantAfterRestart = await window.textContent('.ad-message--assistant .ad-message__text').catch(() => '')
    console.log('[e2e] assistant reply after restart (first 300 chars):', (assistantAfterRestart ?? '').slice(0, 300).replace(/\n/g, ' '))
    console.log('[e2e]', (assistantAfterRestart ?? '').trim().length > 0 ? 'PASS' : 'FAIL', '- a real, non-empty assistant reply persisted and survived the restart')
    let chromeLeakedAfterRestart = false
    for (const pattern of CHROME_PATTERNS) {
      if (pattern.test(assistantAfterRestart ?? '')) chromeLeakedAfterRestart = true
    }
    console.log('[e2e]', chromeLeakedAfterRestart ? 'FAIL' : 'PASS', '- assistant reply stays clean of chrome after an AgentDock restart')
  } finally {
    await electronApp.close().catch(() => {})
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(workspaceDir, { recursive: true, force: true })
    console.log('[e2e] cleaned up disposable temp directories')
  }
}

main().catch((err) => {
  console.error('[e2e] FAILED', err)
  process.exit(1)
})
