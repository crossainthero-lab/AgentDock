import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import type { CreateSessionInput } from '@shared/types'
import { sessionService } from '../services/session-service'
import type { SessionEventEnvelope } from '@shared/events/agent-event'
import type { TraceEventEnvelope } from '@shared/events/trace-event'

const wired = new Set<string>()

/** Guarded by `wired` — this body runs exactly once per session no matter
 *  how many times the renderer re-mounts/re-fetches it (e.g. switching
 *  sessions and back), so there is exactly one main-process subscription
 *  forwarding this session's events/terminal data/trace into the window,
 *  for the lifetime of the app. */
export function ensureForwarding(window: BrowserWindow, sessionId: string): void {
  if (wired.has(sessionId)) return
  wired.add(sessionId)

  sessionService.onEvent(sessionId, (payload) => {
    if (window.isDestroyed()) return
    const envelope: SessionEventEnvelope = { sessionId, event: payload.event, sequence: payload.sequence, eventId: payload.eventId }
    window.webContents.send(IpcChannels.sessionEvent, envelope)
  })
  sessionService.onTerminalData(sessionId, (data) => {
    if (window.isDestroyed()) return
    window.webContents.send(IpcChannels.terminalData, { sessionId, data })
  })
  sessionService.onTerminalExit(sessionId, (info) => {
    if (window.isDestroyed()) return
    window.webContents.send(IpcChannels.terminalExit, { sessionId, info })
  })
  sessionService.onTrace(sessionId, (trace) => {
    if (window.isDestroyed()) return
    const envelope: TraceEventEnvelope = { sessionId, trace }
    window.webContents.send(IpcChannels.sessionTrace, envelope)
  })
}

export function registerSessionIpc(window: BrowserWindow): void {
  ipcMain.handle(IpcChannels.sessionCreate, (_event, input: CreateSessionInput) => {
    const session = sessionService.create(input)
    ensureForwarding(window, session.id)
    return session
  })

  ipcMain.handle(IpcChannels.sessionList, (_event, workspaceId: string) => sessionService.list(workspaceId))

  ipcMain.handle(IpcChannels.sessionGet, (_event, sessionId: string) => {
    ensureForwarding(window, sessionId)
    return sessionService.get(sessionId)
  })

  ipcMain.handle(IpcChannels.sessionSendPrompt, async (_event, sessionId: string, text: string, turnId: string) => {
    ensureForwarding(window, sessionId)
    await sessionService.sendPrompt(sessionId, text, turnId)
  })

  ipcMain.handle(IpcChannels.sessionInterrupt, (_event, sessionId: string) => sessionService.interrupt(sessionId))
  ipcMain.handle(IpcChannels.sessionStop, (_event, sessionId: string) => sessionService.stop(sessionId))
  ipcMain.handle(IpcChannels.sessionDelete, (_event, sessionId: string) => {
    sessionService.delete(sessionId)
    wired.delete(sessionId)
  })

  ipcMain.handle(
    IpcChannels.sessionRespondInteraction,
    (_event, sessionId: string, interactionId: string, optionId: string) =>
      sessionService.respondToInteraction(sessionId, interactionId, optionId)
  )
  ipcMain.handle(IpcChannels.sessionSetModel, (_event, sessionId: string, modelId: string) =>
    sessionService.setModel(sessionId, modelId)
  )
  ipcMain.handle(IpcChannels.sessionRunCommand, (_event, sessionId: string, commandId: string) =>
    sessionService.runCommand(sessionId, commandId)
  )
}
