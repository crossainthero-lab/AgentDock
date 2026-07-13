import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChangedFile, ChangedFileStatus, DiffResult } from '@shared/types'
import { settingsService } from './settings-service'

function gitExecutable(): string {
  return settingsService.get().advanced.gitExecutablePath || 'git'
}

function execGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(gitExecutable(), args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message))
        return
      }
      resolve(stdout)
    })
  })
}

interface NumstatEntry {
  additions: number | null
  deletions: number | null
}

export function parseNumstat(output: string): Map<string, NumstatEntry> {
  const map = new Map<string, NumstatEntry>()
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    const [added, deleted, path] = line.split('\t')
    if (!path) continue
    map.set(path, {
      additions: added === '-' ? null : Number(added),
      deletions: deleted === '-' ? null : Number(deleted)
    })
  }
  return map
}

export function parseStatusLine(line: string): { status: ChangedFileStatus; path: string } | null {
  if (line.length < 3) return null
  const code = line.slice(0, 2)
  let rest = line.slice(3)

  if (code === '??') return { status: 'untracked', path: rest }

  if (code.includes('R')) {
    const parts = rest.split(' -> ')
    rest = parts[1] ?? rest
    return { status: 'renamed', path: rest }
  }
  if (code.includes('D')) return { status: 'deleted', path: rest }
  if (code.includes('A')) return { status: 'added', path: rest }
  return { status: 'modified', path: rest }
}

export const gitService = {
  async branch(workspacePath: string): Promise<string | null> {
    try {
      const out = await execGit(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
      const branch = out.trim()
      return branch === 'HEAD' ? null : branch || null
    } catch {
      return null
    }
  },

  async changedFiles(workspacePath: string): Promise<ChangedFile[]> {
    let statusOutput: string
    try {
      statusOutput = await execGit(workspacePath, ['status', '--porcelain=v1', '--untracked-files=all'])
    } catch {
      return []
    }

    const [unstaged, staged] = await Promise.all([
      execGit(workspacePath, ['diff', '--numstat']).catch(() => ''),
      execGit(workspacePath, ['diff', '--numstat', '--cached']).catch(() => '')
    ])
    const unstagedMap = parseNumstat(unstaged)
    const stagedMap = parseNumstat(staged)

    const files: ChangedFile[] = []
    for (const line of statusOutput.split('\n')) {
      if (!line.trim()) continue
      const parsed = parseStatusLine(line)
      if (!parsed) continue
      const counts = stagedMap.get(parsed.path) ?? unstagedMap.get(parsed.path)
      files.push({
        path: parsed.path,
        status: parsed.status,
        additions: counts?.additions ?? null,
        deletions: counts?.deletions ?? null
      })
    }
    return files
  },

  async diff(workspacePath: string, filePath: string): Promise<DiffResult> {
    const files = await this.changedFiles(workspacePath)
    const entry = files.find((f) => f.path === filePath)

    if (entry?.status === 'untracked') {
      try {
        const content = await readFile(join(workspacePath, filePath), 'utf8')
        return { path: filePath, diff: content, isBinary: false }
      } catch {
        return { path: filePath, diff: '', isBinary: true }
      }
    }

    let diff = await execGit(workspacePath, ['diff', '--', filePath]).catch(() => '')
    if (!diff.trim()) {
      diff = await execGit(workspacePath, ['diff', '--cached', '--', filePath]).catch(() => '')
    }
    const isBinary = diff.includes('Binary files') || (diff === '' && entry?.additions === null)
    return { path: filePath, diff, isBinary }
  },

  async revertFile(workspacePath: string, filePath: string): Promise<void> {
    const files = await this.changedFiles(workspacePath)
    const entry = files.find((f) => f.path === filePath)
    if (!entry) throw new Error(`${filePath} is not a changed file.`)
    if (entry.status === 'untracked') {
      throw new Error('Untracked files cannot be reverted — that would delete work that was never committed.')
    }
    await execGit(workspacePath, ['checkout', '--', filePath])
  }
}
