// Manual, local-only end-to-end smoke test for the Antigravity integration,
// run against the REAL built Electron app (via Playwright's `_electron`
// launcher — a genuine main process, real IPC, real preload bridge, real
// spawned `agy` process) — not a browser mock. Requires:
//   - `npm run build` has been run (launches out/main/index.js directly)
//   - `agy` installed and already authenticated on this machine
//   - `playwright` installed (npm install --save-dev playwright)
//
// Not part of `npm run test` / CI — it depends on real external CLI/account
// state this machine has and others may not. Run manually:
//   node scripts/e2e-antigravity-smoke.cjs
//
// Uses AGENTDOCK_USER_DATA_DIR (see src/main/index.ts) to redirect the
// sqlite DB and Electron's single-instance lock to a disposable temp
// directory — never touches the real user's AgentDock data — and a fresh
// temp workspace directory so it never touches a real project either.
const { _electron: electron } = require('playwright')
const path = require('path')
const os = require('os')
const fs = require('fs')

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-e2e-'))
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-e2e-ws-'))
  fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# e2e smoke test workspace\n')
  console.log('[e2e] userDataDir:', userDataDir)
  console.log('[e2e] workspaceDir:', workspaceDir)

  const electronApp = await electron.launch({
    args: [path.join(__dirname, '../out/main/index.js')],
    env: { ...process.env, AGENTDOCK_USER_DATA_DIR: userDataDir }
  })

  try {
    // Bypasses the native OS folder picker only — everything downstream
    // (workspaceRepo.upsert, IPC, renderer) is exercised for real.
    await electronApp.evaluate(async ({ dialog }, wsDir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [wsDir] })
    }, workspaceDir)

    const window = await electronApp.firstWindow()
    await window.waitForTimeout(800)

    await window.click('text=Open Project')
    await window.waitForTimeout(800)

    const startButton = await window.$('text=Start with Antigravity')
    if (!startButton) {
      console.log('[e2e] FAIL: Antigravity not detected as installed — is agy on PATH?')
      process.exitCode = 1
      return
    }
    await startButton.click()
    await window.waitForTimeout(1500)

    const modelButton = await window.$('button:has-text("Model")')
    if (!modelButton) {
      console.log('[e2e] FAIL: Model menu control not found in session header')
      process.exitCode = 1
      return
    }
    await modelButton.click()
    await window.waitForTimeout(400)
    const bodyAfterMenu = await window.textContent('body')
    const hasRealModels = /Gemini|Claude Sonnet|Claude Opus|GPT-OSS/.test(bodyAfterMenu ?? '')
    console.log('[e2e]', hasRealModels ? 'PASS' : 'FAIL', '- real model catalogue populated the Model menu')
    const backdrop = await window.$('.ad-menu-backdrop')
    if (backdrop) await backdrop.click()
    await window.waitForTimeout(200)

    console.log('[e2e] sending a message — this may trigger a real workspace-trust prompt on first use')
    const textarea = await window.$('textarea')
    await textarea.fill('Reply with just the word: acknowledged')
    await window.click('.ad-composer__send')

    let answeredTrust = false
    for (let i = 0; i < 20; i++) {
      await window.waitForTimeout(2000)
      if ((await window.$$('.ad-interaction-card')).length > 0) {
        answeredTrust = true
        await window.click('text=Yes, I trust this folder')
        console.log('[e2e] PASS - real workspace-trust interaction card appeared and was answered')
        break
      }
      const bubbles = await window.$$('.ad-message--assistant')
      if (bubbles.length > 0) break // no trust prompt this time (already trusted)
    }
    if (!answeredTrust) console.log('[e2e] (no trust prompt this run — workspace already trusted)')

    console.log('[e2e] waiting up to 180s for a real assistant reply')
    let gotReply = false
    for (let i = 0; i < 90; i++) {
      await window.waitForTimeout(2000)
      const status = (await window.textContent('.ad-session-header__status').catch(() => '')) ?? ''
      const bubbles = await window.$$('.ad-message--assistant')
      if (bubbles.length > 0 && status.trim() === 'Ready') {
        gotReply = true
        break
      }
    }
    console.log('[e2e]', gotReply ? 'PASS' : 'FAIL (or slow/rate-limited)', '- real assistant reply rendered and turn settled to Ready')

    if (gotReply) {
      await window.waitForTimeout(1000)
      await electronApp.close()

      // Relaunch against the SAME userDataDir to prove the reply survives
      // an AgentDock restart (real requirement — not just live in-memory).
      const relaunch = await electron.launch({
        args: [path.join(__dirname, '../out/main/index.js')],
        env: { ...process.env, AGENTDOCK_USER_DATA_DIR: userDataDir }
      })
      try {
        const initSqlJs = require('sql.js')
        const SQL = await initSqlJs()
        const buf = fs.readFileSync(path.join(userDataDir, 'agentdock.sqlite3'))
        const db = new SQL.Database(buf)
        const res = db.exec("SELECT content_json FROM messages WHERE role = 'assistant'")
        const persisted = res.length > 0 && res[0].values.length > 0
        console.log('[e2e]', persisted ? 'PASS' : 'FAIL', '- assistant reply persisted to sqlite and survives a restart')
      } finally {
        await relaunch.close()
      }
    }
  } finally {
    await electronApp.close().catch(() => {})
  }
}

main().catch((err) => {
  console.error('[e2e] FAILED', err)
  process.exit(1)
})
