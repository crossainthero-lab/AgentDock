// One-off capture harness — NOT part of the app, not committed as a feature.
// Spawns the real claude/codex/agy CLIs under a real node-pty PTY, using the
// exact argv each adapter already builds, against a disposable scratch
// workspace, and writes raw captured bytes to disk for inspection. Used to
// replace guessed classifier rules with rules grounded in real output. Must
// run inside an Electron-hosted Node process (see electron-node-runner.js)
// since node-pty is loaded against Electron's ABI, same as pty-smoke-test.js.
const path = require('node:path')
const { runUnderElectron } = require('./electron-node-runner')

runUnderElectron(path.join(__dirname, 'capture-cli-output-impl.js'), process.argv.slice(2))
