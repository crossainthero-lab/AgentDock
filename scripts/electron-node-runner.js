// Shared helper for scripts that must run inside an Electron-hosted Node
// process rather than the system Node. Native modules like node-pty are
// loaded against whichever Node/V8 ABI is running them; when they're
// installed via prebuilds targeting Electron's bundled Node, running them
// under a plain `node` binary can disagree with what's on disk. Launching
// the real Electron binary with ELECTRON_RUN_AS_NODE=1 gives a Node-compatible
// process that actually matches what the packaged app will use at runtime.
const { spawnSync } = require('node:child_process')
const path = require('node:path')

function runUnderElectron(scriptPath, args = []) {
  const electronPath = require('electron')
  const result = spawnSync(electronPath, [scriptPath, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..')
  })
  if (result.error) {
    console.error('Failed to launch Electron-hosted Node process:', result.error)
    process.exit(1)
  }
  process.exit(result.status ?? 1)
}

module.exports = { runUnderElectron }
