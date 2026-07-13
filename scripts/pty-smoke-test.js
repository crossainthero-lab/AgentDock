// Real end-to-end node-pty smoke test. Must run inside an Electron-hosted
// Node process (see pty-smoke-runner.js) since node-pty is loaded against
// Electron's ABI. Exercises: real PTY spawn, output receipt, input write,
// resize, and clean process exit — no mocks.
const pty = require('node-pty')
const os = require('node:os')

const MARKER = `AGENTDOCK_PTY_SMOKE_${Date.now()}`
const TIMEOUT_MS = 15000

function fail(message) {
  console.error(`[pty-smoke] FAIL: ${message}`)
  process.exit(1)
}

function pass(message) {
  console.log(`[pty-smoke] OK: ${message}`)
}

if (os.platform() !== 'win32') {
  fail('this smoke test is Windows-specific (ConPTY)')
}

console.log('[pty-smoke] spawning cmd.exe under a real ConPTY...')

const shell = pty.spawn('cmd.exe', [], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
  useConpty: true
})

pass(`spawned, pid=${shell.pid}`)

let outputBuffer = ''
let sawMarker = false
let resized = false
let exited = false

const timeout = setTimeout(() => {
  if (!exited) {
    console.error('[pty-smoke] timed out waiting for expected output/exit')
    console.error('[pty-smoke] last output buffer:\n' + outputBuffer.slice(-2000))
    try {
      shell.kill()
    } catch {
      // already dead
    }
    process.exit(1)
  }
}, TIMEOUT_MS)

shell.onData((chunk) => {
  outputBuffer += chunk

  if (!sawMarker && outputBuffer.includes(MARKER)) {
    sawMarker = true
    pass('received expected output through PTY data event')

    try {
      shell.resize(100, 30)
      resized = true
      pass('resize() did not throw')
    } catch (err) {
      fail(`resize() threw: ${err.message}`)
    }

    // Input write after the marker: ask the shell to exit cleanly.
    shell.write('exit\r')
  }
})

shell.onExit(({ exitCode, signal }) => {
  exited = true
  clearTimeout(timeout)

  if (!sawMarker) {
    fail('process exited before we ever saw the expected marker output')
  }
  if (!resized) {
    fail('process exited before resize() was exercised')
  }

  pass(`process exited cleanly (exitCode=${exitCode}, signal=${signal ?? 'none'})`)
  console.log('[pty-smoke] ALL CHECKS PASSED')
  process.exit(0)
})

// Real input write: echo a marker we can detect in the output stream.
shell.write(`echo ${MARKER}\r`)
