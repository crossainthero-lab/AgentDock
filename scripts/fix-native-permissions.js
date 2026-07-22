// npm's tarball extraction does not reliably preserve the executable bit
// on every platform for every package — confirmed live on this machine:
// node-pty ships a small native `spawn-helper` binary in each POSIX
// prebuilds directory (darwin-x64, darwin-arm64, and the equivalent Linux
// ones) that UnixTerminal shells out to in order to actually fork/exec a
// PTY session, and after a plain `npm ci` it came out as a plain
// non-executable file (mode 644) — `pty.spawn()` then fails outright with
// "posix_spawnp failed". Windows has no equivalent concept (executability
// there is extension-based, not a permission bit — see
// executable-resolver.ts), which is exactly why this never surfaced during
// the Windows-only pass. Runs as `postinstall` so every fresh clone/install
// gets a working PTY without a manual `chmod` step, and is also invoked
// explicitly before packaging as a belt-and-suspenders check.
const fs = require('node:fs')
const path = require('node:path')

function chmodIfExists(filePath) {
  if (!fs.existsSync(filePath)) return
  try {
    fs.chmodSync(filePath, 0o755)
    console.log(`[fix-native-permissions] chmod +x ${filePath}`)
  } catch (err) {
    console.warn(`[fix-native-permissions] could not chmod ${filePath}:`, err.message)
  }
}

function main() {
  let ptyPkgDir
  try {
    ptyPkgDir = path.dirname(require.resolve('node-pty/package.json'))
  } catch {
    // node-pty isn't installed yet (e.g. a partial/failed install) —
    // nothing for this script to fix; not this script's job to error.
    return
  }

  const prebuildsDir = path.join(ptyPkgDir, 'prebuilds')
  if (!fs.existsSync(prebuildsDir)) return

  for (const entry of fs.readdirSync(prebuildsDir)) {
    if (entry.startsWith('win32-')) continue // no spawn-helper on Windows
    chmodIfExists(path.join(prebuildsDir, entry, 'spawn-helper'))
  }

  // A locally-rebuilt (electron-rebuild) native module lands here instead
  // of prebuilds/ — check it too, for the same reason.
  chmodIfExists(path.join(ptyPkgDir, 'build', 'Release', 'spawn-helper'))
}

main()
