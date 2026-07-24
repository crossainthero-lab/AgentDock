// electron-builder.yml sets `win.signAndEditExecutable: false` — real code
// signing is out of scope for this project, and electron-builder's own
// rcedit invocation for icon-embedding is bundled together with the
// winCodeSign download, which fails to extract on this machine (non-elevated
// Windows accounts can't create the symlinks inside that archive). Skipping
// it, though, means the packaged .exe keeps Electron's default icon.
//
// This hook runs the standalone `rcedit` package (no winCodeSign, no
// symlinks, just a plain .exe resource editor) directly against the packed
// app's .exe, embedding the real AgentDock icon — before NSIS/portable
// wrap it, so both installer-built and portable exes get it too, not just
// the unpacked --dir output.
const path = require('node:path')
const fs = require('node:fs')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
  if (!fs.existsSync(exePath)) return

  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico')
  // rcedit@5 ships ESM-only ("type": "module") and exports a named
  // `rcedit` function (no default export) — require() from this CJS script
  // yields the module namespace object, so it must be destructured rather
  // than called directly.
  const { rcedit } = require('rcedit')
  await rcedit(exePath, { icon: iconPath })
}
