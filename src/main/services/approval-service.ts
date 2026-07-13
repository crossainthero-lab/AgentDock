// Tracks approval requests surfaced by an adapter's `approval-request` event
// and records "allow for session" decisions.
//
// None of the three current adapters actually emit `approval-request`
// (documented in each adapter file — the interactive permission wire
// protocols aren't confidently verified), so in practice this plumbing sits
// idle. It's still wired end-to-end rather than stubbed out so the
// ApprovalDialog activates correctly the moment any adapter does emit a
// genuine request, with no separate "make it real later" step.
import type { ApprovalDecision, ApprovalRequest } from '@shared/types'
import { approvalMemoryRepo } from '../db/repositories/approval-memory-repo'

const requestListeners = new Set<(request: ApprovalRequest) => void>()
const decisionListeners = new Map<string, Set<(decision: ApprovalDecision) => void>>()
const pendingRequests = new Map<string, ApprovalRequest>()

export const approvalService = {
  onRequest(cb: (request: ApprovalRequest) => void): () => void {
    requestListeners.add(cb)
    return () => requestListeners.delete(cb)
  },

  publish(request: ApprovalRequest): void {
    const remembered = approvalMemoryRepo.getSessionDecision(request.sessionId, request.command)
    if (remembered) {
      this.respond(request.id, remembered)
      return
    }
    pendingRequests.set(request.id, request)
    for (const listener of requestListeners) listener(request)
  },

  /** Adapters that pause execution pending a decision can await this. */
  waitForDecision(approvalId: string): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const set = decisionListeners.get(approvalId) ?? new Set()
      set.add(resolve)
      decisionListeners.set(approvalId, set)
    })
  },

  respond(approvalId: string, decision: ApprovalDecision): void {
    const request = pendingRequests.get(approvalId)
    if (decision === 'allow-session' && request) {
      approvalMemoryRepo.record(request.sessionId, request.command, decision)
    }
    pendingRequests.delete(approvalId)

    const listeners = decisionListeners.get(approvalId)
    if (listeners) {
      for (const resolve of listeners) resolve(decision)
      decisionListeners.delete(approvalId)
    }
  }
}
