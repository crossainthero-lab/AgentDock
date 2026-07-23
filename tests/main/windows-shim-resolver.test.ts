import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isWindowsShim, resolveShimTarget } from '../../src/main/services/windows-shim-resolver'

// Root-cause coverage: an npm-installed CLI (Claude Code, Codex, Antigravity)
// resolves to a `.cmd`/`.bat` shim on Windows whenever its install method
// produces one — a completely normal, common shape that simply doesn't
// exist on a machine where the same CLI happens to be a native .exe
// instead. Every fixture here is a real file under a generated temp
// directory, never the developer's real install of anything.

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

describe('isWindowsShim', () => {
  it('is true for a .cmd path on win32', () => {
    withPlatform('win32', () => {
      expect(isWindowsShim('C:\\Users\\Someone\\AppData\\Roaming\\npm\\codex.cmd')).toBe(true)
    })
  })

  it('is true for a .bat path on win32', () => {
    withPlatform('win32', () => {
      expect(isWindowsShim('C:\\tools\\thing.bat')).toBe(true)
    })
  })

  it('is false for a .exe path on win32', () => {
    withPlatform('win32', () => {
      expect(isWindowsShim('C:\\Program Files\\Thing\\thing.exe')).toBe(false)
    })
  })

  it('is false for a bare command name with no extension', () => {
    withPlatform('win32', () => {
      expect(isWindowsShim('codex')).toBe(false)
    })
  })

  it('is false on macOS even for a path that happens to end in .cmd', () => {
    withPlatform('darwin', () => {
      expect(isWindowsShim('/usr/local/bin/thing.cmd')).toBe(false)
    })
  })

  it('is false on Linux even for a path that happens to end in .bat', () => {
    withPlatform('linux', () => {
      expect(isWindowsShim('/usr/local/bin/thing.bat')).toBe(false)
    })
  })
})

describe('resolveShimTarget', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'agentdock-shim-'))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('resolves the standard npm JS-launcher shim shape to node + the real .js entry point', () => {
    const jsEntry = join(tempRoot, 'cli.js')
    writeFileSync(jsEntry, '// pretend CLI entry point\n')
    const shimPath = join(tempRoot, 'codex.cmd')
    writeFileSync(
      shimPath,
      [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        '"%dp0%\\node.exe" "%dp0%\\cli.js" %*'
      ].join('\r\n')
    )

    const target = resolveShimTarget(shimPath)
    expect(target).not.toBeNull()
    expect(target!.args).toEqual([jsEntry])
    // No node.exe bundled next to this particular shim in the fixture, so
    // it should fall back to the bare `node` command (relying on PATH) —
    // matching the shim's own fallback behavior when it can't find one
    // either.
    expect(target!.command).toBe('node')
  })

  it('prefers a node.exe bundled next to the shim over the bare "node" fallback', () => {
    const jsEntry = join(tempRoot, 'cli.js')
    writeFileSync(jsEntry, '// pretend CLI entry point\n')
    const bundledNode = join(tempRoot, 'node.exe')
    writeFileSync(bundledNode, '')
    const shimPath = join(tempRoot, 'codex.cmd')
    writeFileSync(shimPath, `"%dp0%\\node.exe" "%dp0%\\cli.js" %*`)

    const target = resolveShimTarget(shimPath)
    expect(target).not.toBeNull()
    expect(target!.command).toBe(bundledNode)
    expect(target!.args).toEqual([jsEntry])
  })

  it('resolves a shim that directly references a native binary (no node/JS involved)', () => {
    const realExe = join(tempRoot, 'codex-win32-x64.exe')
    writeFileSync(realExe, '')
    const shimPath = join(tempRoot, 'codex.cmd')
    writeFileSync(shimPath, `"%dp0%\\codex-win32-x64.exe" %*`)

    const target = resolveShimTarget(shimPath)
    expect(target).not.toBeNull()
    expect(target!.command).toBe(realExe)
    expect(target!.args).toEqual([])
  })

  it('returns null when the referenced target does not actually exist on disk', () => {
    const shimPath = join(tempRoot, 'codex.cmd')
    writeFileSync(shimPath, `"%dp0%\\nonexistent.exe" %*`)
    expect(resolveShimTarget(shimPath)).toBeNull()
  })

  it('returns null for a shim with no recognizable quoted target', () => {
    const shimPath = join(tempRoot, 'weird.cmd')
    writeFileSync(shimPath, '@ECHO off\r\necho hello world\r\n')
    expect(resolveShimTarget(shimPath)).toBeNull()
  })

  it('returns null (never throws) when the shim file does not exist at all', () => {
    expect(resolveShimTarget(join(tempRoot, 'does-not-exist.cmd'))).toBeNull()
  })

  it('resolves correctly even when the shim directory path itself has spaces and non-ASCII characters', () => {
    const unicodeDir = join(tempRoot, 'Programs (x86) 日本語')
    mkdirSync(unicodeDir, { recursive: true })
    const realExe = join(unicodeDir, 'codex.exe')
    writeFileSync(realExe, '')
    const shimPath = join(unicodeDir, 'codex.cmd')
    writeFileSync(shimPath, `"%dp0%\\codex.exe" %*`)

    const target = resolveShimTarget(shimPath)
    expect(target).not.toBeNull()
    expect(target!.command).toBe(realExe)
  })
})
