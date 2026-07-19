// Manual, local-only end-to-end verification of the EXACT reported turn-
// misattribution bug, run against the REAL built Electron app (via
// Playwright's `_electron` launcher — genuine main process, real IPC, real
// spawned `agy` process) in a disposable temp workspace. Requires:
//   - `npm run build` has been run (launches out/main/index.js directly)
//   - `agy` installed and already authenticated on this machine
//   - `playwright` installed (npm install --save-dev playwright)
//
// Not part of `npm run test` / CI. Run manually:
//   node scripts/e2e-antigravity-turn-correlation.cjs
//
// Repro sequence (verbatim from the bug report): send "Make a simple python
// script" once, wait for it to genuinely execute; then send "Sandwhich!" and
// verify it gets its own distinct reply — never the earlier python task
// replayed/re-summarized.
const { _electron: electron } = require('playwright')
const path = require('path')
const os = require('os')
const fs = require('fs')

function log(pass, msg) {
  console.log(`[e2e] ${pass ? 'PASS' : 'FAIL'} - ${msg}`)
  if (!pass) process.exitCode = 1
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-turncorr-'))
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-turncorr-ws-'))
  console.log('[e2e] userDataDir:', userDataDir)
  console.log('[e2e] workspaceDir:', workspaceDir)

  const electronApp = await electron.launch({
    args: [path.join(__dirname, '../out/main/index.js')],
    env: { ...process.env, AGENTDOCK_USER_DATA_DIR: userDataDir, AGENTDOCK_DEBUG_RAW_PTY: '1' }
  })
  electronApp.process().stdout.on('data', (d) => process.stdout.write(`[main-stdout] ${d}`))
  electronApp.process().stderr.on('data', (d) => process.stdout.write(`[main-stderr] ${d}`))
  electronApp.on('close', () => console.log('[e2e] electronApp closed'))

  try {
    await electronApp.evaluate(async ({ dialog }, wsDir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [wsDir] })
    }, workspaceDir)

    const window = await electronApp.firstWindow()
    window.on('crash', () => console.log('[e2e] renderer CRASHED'))
    window.on('close', () => console.log('[e2e] renderer window closed'))
    window.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`[renderer-console-error] ${msg.text()}`)
    })
    window.on('pageerror', (err) => console.log(`[renderer-pageerror] ${err.message}`))
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

    // --- Turn 1: the exact reported first message ---
    console.log('[e2e] sending turn 1: "Make a simple python script"')
    const textarea = await window.$('textarea')
    await textarea.fill('Make a simple python script')
    await window.click('.ad-composer__send')

    // Answer a workspace-trust prompt if one appears, same as the general smoke test.
    for (let i = 0; i < 10; i++) {
      await window.waitForTimeout(1000)
      const cards = await window.$$('.ad-interaction-card')
      if (cards.length > 0) {
        const trustBtn = await window.$('text=Yes, I trust this folder')
        if (trustBtn) {
          await trustBtn.click()
          console.log('[e2e] answered workspace-trust prompt')
        }
        break
      }
      if ((await window.$$('.ad-message--assistant')).length > 0) break
    }

    console.log('[e2e] waiting up to 180s for turn 1 to settle (status: Ready)')
    let turn1Settled = false
    for (let i = 0; i < 90; i++) {
      await window.waitForTimeout(2000)
      const status = (await window.textContent('.ad-session-header__status').catch(() => '')) ?? ''
      // Any pending interaction (e.g. a permission prompt) — answer it and keep waiting.
      const permCard = await window.$('.ad-interaction-card')
      if (permCard) {
        const yesBtn = await window.$('.ad-interaction-card button:has-text("Yes")')
        if (yesBtn) await yesBtn.click()
      }
      if (status.trim() === 'Ready' && (await window.$$('.ad-message--assistant')).length > 0) {
        turn1Settled = true
        break
      }
    }
    log(turn1Settled, 'turn 1 settled to Ready with an assistant reply rendered')

    const assistantBubblesAfterTurn1 = await window.$$('.ad-message--assistant')
    log(assistantBubblesAfterTurn1.length === 1, `exactly one assistant bubble after turn 1 (found ${assistantBubblesAfterTurn1.length})`)

    const turn1Text = assistantBubblesAfterTurn1.length > 0 ? await assistantBubblesAfterTurn1[0].textContent() : ''
    const isGenericGreeting = /How can I help|What's on your mind|Hey again/i.test(turn1Text ?? '')
    log(!isGenericGreeting, `turn 1's reply is not a generic startup greeting (text: ${JSON.stringify((turn1Text ?? '').slice(0, 200))})`)

    // Verify the script was actually created and is runnable in the workspace.
    const pyFiles = fs.readdirSync(workspaceDir).filter((f) => f.endsWith('.py'))
    log(pyFiles.length > 0, `a .py file was created in the workspace during turn 1 (found: ${JSON.stringify(pyFiles)})`)
    if (pyFiles.length > 0) {
      const { execSync } = require('child_process')
      try {
        const out = execSync(`python "${path.join(workspaceDir, pyFiles[0])}"`, { timeout: 10000 }).toString()
        log(true, `the created script runs successfully (output: ${JSON.stringify(out.slice(0, 200))})`)
      } catch (err) {
        log(false, `the created script failed to run: ${err.message}`)
      }
    }

    // --- Turn 2: the exact reported follow-up ---
    console.log('[e2e] sending turn 2: "Sandwhich!"')
    const textarea2 = await window.$('textarea')
    await textarea2.fill('Sandwhich!')
    await window.click('.ad-composer__send')

    console.log('[e2e] waiting up to 300s for turn 2 to settle (status: Ready)')
    let turn2Settled = false
    for (let i = 0; i < 150; i++) {
      await window.waitForTimeout(2000)
      const status = (await window.textContent('.ad-session-header__status').catch(() => '')) ?? ''
      const permCard = await window.$('.ad-interaction-card')
      if (permCard) {
        const yesBtn = await window.$('.ad-interaction-card button:has-text("Yes")')
        if (yesBtn) {
          await yesBtn.click()
          console.log('[e2e] answered an interaction prompt during turn 2')
        }
      }
      if (i % 10 === 0) console.log(`[e2e] turn 2 poll ${i}: status="${status.trim()}"`)
      if (status.trim() === 'Ready' && (await window.$$('.ad-message--assistant')).length >= 2) {
        turn2Settled = true
        break
      }
    }
    log(turn2Settled, 'turn 2 settled to Ready with a second assistant reply rendered')
    if (!turn2Settled) {
      const finalStatus = (await window.textContent('.ad-session-header__status').catch(() => '')) ?? ''
      const bodyText = (await window.textContent('body').catch(() => '')) ?? ''
      console.log(`[e2e] DIAGNOSTIC final status: "${finalStatus.trim()}"`)
      console.log(`[e2e] DIAGNOSTIC body tail: ${JSON.stringify(bodyText.slice(-800))}`)
      await window.screenshot({ path: path.join(os.tmpdir(), 'agentdock-turn2-timeout.png') }).catch(() => {})
      console.log(`[e2e] DIAGNOSTIC screenshot saved to ${path.join(os.tmpdir(), 'agentdock-turn2-timeout.png')}`)
    }

    const assistantBubblesAfterTurn2 = await window.$$('.ad-message--assistant')
    log(assistantBubblesAfterTurn2.length === 2, `exactly two assistant bubbles total after turn 2 (found ${assistantBubblesAfterTurn2.length})`)

    if (assistantBubblesAfterTurn2.length >= 2) {
      const turn2Text = await assistantBubblesAfterTurn2[1].textContent()
      // Checks for the earlier turn's own filename/output specifically —
      // not "python script" generically, since a legitimate distinct reply
      // to "Sandwhich!" may itself create and describe a NEW python script
      // (e.g. "sandwich.py") without that being a replay of anything.
      const replaysPythonTask = new RegExp(pyFiles[0]?.replace('.', '\\.') ?? 'hello\\.py', 'i').test(turn2Text ?? '')
      log(!replaysPythonTask, `turn 2's reply does not replay/re-summarize the earlier python task (text: ${JSON.stringify((turn2Text ?? '').slice(0, 200))})`)

      // The user message bubbles must also be exactly one-per-send, in order.
      const userBubbles = await window.$$('.ad-message--user')
      const userTexts = await Promise.all(userBubbles.map((b) => b.textContent()))
      log(
        userTexts.length === 2 && /python script/i.test(userTexts[0] ?? '') && /Sandwhich/i.test(userTexts[1] ?? ''),
        `exactly two user messages in the correct order (found: ${JSON.stringify(userTexts)})`
      )
    }

    console.log('[e2e] done — inspect PASS/FAIL lines above')
  } finally {
    await electronApp.close().catch(() => {})
  }
}

main().catch((err) => {
  console.error('[e2e] FAILED', err)
  process.exit(1)
})
