import { safeHandle } from './ipc-utils'
import { IpcChannels } from '@shared/ipc-channels'
import { gitService } from '../services/git-service'
import { workspaceRepo } from '../db/repositories/workspace-repo'

function pathFor(workspaceId: string): string {
  const workspace = workspaceRepo.get(workspaceId)
  if (!workspace) throw new Error('Workspace not found.')
  return workspace.path
}

export function registerGitIpc(): void {
  safeHandle(IpcChannels.gitChangedFiles, (_event, workspaceId: string) =>
    gitService.changedFiles(pathFor(workspaceId))
  )
  safeHandle(IpcChannels.gitDiff, (_event, workspaceId: string, filePath: string) =>
    gitService.diff(pathFor(workspaceId), filePath)
  )
  safeHandle(IpcChannels.gitBranch, (_event, workspaceId: string) => gitService.branch(pathFor(workspaceId)))
  safeHandle(IpcChannels.gitRevertFile, (_event, workspaceId: string, filePath: string) =>
    gitService.revertFile(pathFor(workspaceId), filePath)
  )
}
