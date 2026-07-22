// Verifies node-pty's native binary and ConPTY runtime files are present and
// loadable under Electron's ABI before we trust the app to use them. Run via
// `npm run native:check` (spawns itself under Electron, see below).
const path = require('node:path')
const fs = require('node:fs')

if (!process.versions.electron) {
  const { runUnderElectron } = require('./electron-node-runner')
  runUnderElectron(__filename)
} else {
  main()
}

function main() {
  const pkgDir = path.dirname(require.resolve('node-pty/package.json'))
  console.log(`[native-check] node-pty package dir: ${pkgDir}`)
  console.log(`[native-check] Electron ABI: ${process.versions.modules} (electron ${process.versions.electron})`)

  const candidateDirs = [
    path.join(pkgDir, 'build', 'Release'),
    path.join(pkgDir, `prebuilds/${process.platform}-${process.arch}`)
  ]

  let ptyNodeDir = null
  for (const dir of candidateDirs) {
    if (fs.existsSync(path.join(dir, 'pty.node'))) {
      ptyNodeDir = dir
      break
    }
  }

  if (!ptyNodeDir) {
    console.error('[native-check] FAIL: could not find pty.node in any of:', candidateDirs)
    process.exit(1)
  }
  console.log(`[native-check] found pty.node at: ${path.join(ptyNodeDir, 'pty.node')}`)

  // ConPTY is a Windows-only runtime dependency of node-pty — macOS/Linux
  // builds don't ship (or need) conpty.dll/OpenConsole.exe at all, so only
  // require them when actually checking a Windows build.
  if (process.platform === 'win32') {
    const conptyDll = path.join(ptyNodeDir, 'conpty', 'conpty.dll')
    const openConsole = path.join(ptyNodeDir, 'conpty', 'OpenConsole.exe')
    for (const file of [conptyDll, openConsole]) {
      if (!fs.existsSync(file)) {
        console.error(`[native-check] FAIL: missing required ConPTY runtime file: ${file}`)
        process.exit(1)
      }
      console.log(`[native-check] found: ${file}`)
    }
  } else {
    console.log('[native-check] non-Windows platform — ConPTY runtime files not applicable, skipping that check')
  }

  let pty
  try {
    pty = require('node-pty')
  } catch (err) {
    console.error('[native-check] FAIL: require("node-pty") threw:', err)
    process.exit(1)
  }
  console.log('[native-check] require("node-pty") succeeded')

  // useConpty is a Windows-only option (node-pty ignores it on POSIX); the
  // shell itself is the one genuinely platform-specific bit of this probe.
  const shell = process.platform === 'win32' ? 'cmd.exe' : process.env.SHELL || '/bin/sh'
  let proc
  try {
    proc = pty.spawn(shell, [], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env, useConpty: true })
  } catch (err) {
    console.error('[native-check] FAIL: pty.spawn() threw:', err)
    process.exit(1)
  }
  console.log(`[native-check] pty.spawn() succeeded, pid=${proc.pid}`)
  proc.onExit(() => {})
  proc.kill()

  console.log('[native-check] ALL CHECKS PASSED')
  process.exit(0)
}
