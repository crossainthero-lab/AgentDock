// Composes the existing CLI detection/diagnostics system (detectionService)
// with best-effort auth detection (cliAuthenticationService) into the
// single per-agent status the CLI Setup Assistant screen and Settings →
// Agents → CLI Setup both read — never a second, competing detection
// mechanism. Automatic detection itself (installed? launchable? a valid
// native executable, not an unsupported shim?) is entirely
// detectionService's job already; this module only classifies its result.
import type { AgentAuthState, AgentDetection, AgentId, CliSetupInfo, CliSetupStatus } from '@shared/types'
import { AGENT_IDS } from '@shared/types'
import { detectionService } from './detection-service'
import { cliAuthenticationService } from './cli-authentication-service'
import { getInstallDefinition } from './cli-install-definitions'
import { settingsService } from './settings-service'

/** Distinguishes "genuinely nothing found" from "found something that
 *  exists on disk but can't actually be launched" using the same rejection-
 *  reason text executable-resolver.ts/codex-runtime-resolver.ts already
 *  produce for exactly that case (an unsupported .cmd/.bat/.ps1/.js/.mjs
 *  shim, a candidate that exists but exits non-zero, a file missing execute
 *  permission) — never re-implements that classification, just reads its
 *  output. */
function looksIncompatible(error: string | null): boolean {
  if (!error) return false
  return /existed but failed to run|shim|not a native windows executable|missing execute permission/i.test(error)
}

/** Detection itself couldn't complete (e.g. the version probe hit
 *  executable-probe.ts's 5s timeout) — different from confidently finding
 *  nothing, and worth telling the user apart from "not installed". */
function looksUnverifiable(error: string | null): boolean {
  if (!error) return false
  return /timed out/i.test(error)
}

function classifyStatus(detection: AgentDetection, authState: AgentAuthState): CliSetupStatus {
  if (!detection.installed) {
    if (looksIncompatible(detection.error)) return 'incompatible'
    if (looksUnverifiable(detection.error)) return 'could-not-verify'
    return 'not-installed'
  }
  if (authState === 'required') return 'needs-login'
  return 'ready'
}

export const cliSetupService = {
  async getStatus(agentId: AgentId): Promise<CliSetupInfo> {
    const customPath = settingsService.get().agents[agentId].customPath
    const detection = await detectionService.detect(agentId, customPath)
    const authState = detection.installed ? await cliAuthenticationService.checkAuthState(agentId) : 'unknown'
    const def = getInstallDefinition(agentId)
    return {
      agentId,
      status: classifyStatus(detection, authState),
      detection,
      authState,
      installSupported: def.supported,
      installSummary: def.summary,
      manualInstructions: def.manualInstructions,
      manualUrl: def.manualUrl
    }
  },

  async getAllStatuses(): Promise<CliSetupInfo[]> {
    return Promise.all(AGENT_IDS.map((id) => this.getStatus(id)))
  }
}
