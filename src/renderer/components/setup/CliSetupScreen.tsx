import type React from 'react'
import { useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronUp, Download, ExternalLink, LogIn, RefreshCw, Terminal as TerminalIcon, X } from 'lucide-react'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Badge } from '../ui/Badge'
import { Spinner } from '../ui/Spinner'
import { CliSetupTerminal } from './CliSetupTerminal'
import { useAppState } from '../../state/AppStateContext'
import { getAgentDock } from '../../lib/agentDockClient'
import { AGENT_DISPLAY_NAMES, type AgentId, type CliInstallOutcome, type CliInstallPlan, type CliSetupInfo, type CliSetupStatus } from '@shared/types'
import './CliSetupScreen.css'

const STATUS_META: Record<CliSetupStatus, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  ready: { label: 'Installed and ready', tone: 'success' },
  'needs-login': { label: 'Installed — sign-in required', tone: 'warning' },
  incompatible: { label: 'Installed but incompatible', tone: 'danger' },
  'not-installed': { label: 'Not installed', tone: 'neutral' },
  'could-not-verify': { label: 'Could not verify', tone: 'neutral' }
}

interface InstallRun {
  installId: string
  running: boolean
  outcome: CliInstallOutcome | null
}

interface SignInRun {
  ptyId: string
  executablePath: string
}

type ConfirmTarget = { mode: 'single'; agentId: AgentId; plan: CliInstallPlan } | { mode: 'all'; plans: CliInstallPlan[] }

/**
 * The first-run/on-demand CLI Setup Assistant — shown automatically at
 * launch when at least one supported agent CLI isn't ready (see
 * AppStateContext's auto-open effect), and reopenable any time from
 * Settings → Agents. Skipping never blocks the rest of the app: AppShell
 * mounts this independently of the normal workspace UI.
 */
export function CliSetupScreen(): React.JSX.Element | null {
  const { cliSetupScreenOpen, closeCliSetupScreen, dismissCliSetupScreen, cliSetupStatuses, cliSetupLoading, refreshCliSetup, setSettingsViewOpen } =
    useAppState()

  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null)
  const [installRuns, setInstallRuns] = useState<Partial<Record<AgentId, InstallRun>>>({})
  const [logOpen, setLogOpen] = useState<Partial<Record<AgentId, boolean>>>({})
  const [manualOpen, setManualOpen] = useState<Partial<Record<AgentId, boolean>>>({})
  const [signIns, setSignIns] = useState<Partial<Record<AgentId, SignInRun>>>({})
  const [signInErrors, setSignInErrors] = useState<Partial<Record<AgentId, string>>>({})
  const [terminalErrors, setTerminalErrors] = useState<Partial<Record<AgentId, string>>>({})
  const [installingAll, setInstallingAll] = useState(false)

  if (!cliSetupScreenOpen) return null

  async function runInstall(agentId: AgentId): Promise<void> {
    const installId = crypto.randomUUID()
    setInstallRuns((prev) => ({ ...prev, [agentId]: { installId, running: true, outcome: null } }))
    setLogOpen((prev) => ({ ...prev, [agentId]: false }))
    const outcome = await getAgentDock().cliSetup.install(agentId, installId)
    setInstallRuns((prev) => ({ ...prev, [agentId]: { installId, running: false, outcome } }))
    await refreshCliSetup()
  }

  async function openSingleConfirm(agentId: AgentId): Promise<void> {
    const plan = await getAgentDock().cliSetup.getPlan(agentId)
    setConfirmTarget({ mode: 'single', agentId, plan })
  }

  async function openInstallAllConfirm(): Promise<void> {
    const targets = cliSetupStatuses.filter((s) => s.status !== 'ready' && s.status !== 'needs-login')
    const plans = await Promise.all(targets.map((t) => getAgentDock().cliSetup.getPlan(t.agentId)))
    setConfirmTarget({ mode: 'all', plans: plans.filter((p) => p.supported) })
  }

  async function confirmInstall(): Promise<void> {
    if (!confirmTarget) return
    const target = confirmTarget
    setConfirmTarget(null)
    if (target.mode === 'single') {
      await runInstall(target.agentId)
      return
    }
    setInstallingAll(true)
    try {
      for (const plan of target.plans) await runInstall(plan.agentId)
    } finally {
      setInstallingAll(false)
    }
  }

  function cancelInstall(agentId: AgentId): void {
    const run = installRuns[agentId]
    if (run) getAgentDock().cliSetup.cancelInstall(run.installId)
  }

  function dismissInstallPanel(agentId: AgentId): void {
    setInstallRuns((prev) => {
      const next = { ...prev }
      delete next[agentId]
      return next
    })
  }

  async function startSignIn(agentId: AgentId): Promise<void> {
    setSignInErrors((prev) => ({ ...prev, [agentId]: undefined }))
    const result = await getAgentDock().cliSetup.signIn(agentId)
    if (!result.ok || !result.ptyId || !result.executablePath) {
      setSignInErrors((prev) => ({ ...prev, [agentId]: result.error ?? 'Could not start sign-in.' }))
      return
    }
    const ptyId = result.ptyId
    getAgentDock().cliSetup.onPtyExit(ptyId, () => {
      setSignIns((prev) => {
        const next = { ...prev }
        delete next[agentId]
        return next
      })
      void refreshCliSetup()
    })
    setSignIns((prev) => ({ ...prev, [agentId]: { ptyId, executablePath: result.executablePath! } }))
  }

  function endSignIn(agentId: AgentId): void {
    const run = signIns[agentId]
    if (run) getAgentDock().cliSetup.ptyKill(run.ptyId)
    setSignIns((prev) => {
      const next = { ...prev }
      delete next[agentId]
      return next
    })
    void refreshCliSetup()
  }

  async function openTerminalFor(agentId: AgentId, purpose: 'install' | 'signIn'): Promise<void> {
    const result = await getAgentDock().cliSetup.openTerminal(agentId, purpose)
    setTerminalErrors((prev) => ({ ...prev, [agentId]: result.launched ? undefined : (result.error ?? 'Could not open a terminal.') }))
  }

  const missingCount = cliSetupStatuses.filter((s) => s.status !== 'ready' && s.status !== 'needs-login' && s.installSupported).length

  return (
    <Dialog
      open={cliSetupScreenOpen}
      onClose={() => {
        // Escape while the confirm dialog is open should only close that
        // one — not skip the whole setup screen as a side effect.
        if (!confirmTarget) void dismissCliSetupScreen()
      }}
      title="CLI Setup"
      width={880}
      closeOnBackdrop={false}
    >
      <div className="ad-cli-setup">
        <p className="ad-cli-setup__intro">
          AgentDock needs the command-line tools used by its agents. We can help install the missing ones.
        </p>

        <div className="ad-cli-setup__cards">
          {cliSetupLoading && cliSetupStatuses.length === 0 ? (
            <div className="ad-cli-setup__loading">
              <Spinner size={16} />
              Checking installed CLIs…
            </div>
          ) : (
            cliSetupStatuses.map((info) => (
              <AgentSetupCard
                key={info.agentId}
                info={info}
                installRun={installRuns[info.agentId] ?? null}
                logOpen={logOpen[info.agentId] ?? false}
                manualOpen={manualOpen[info.agentId] ?? false}
                signIn={signIns[info.agentId] ?? null}
                signInError={signInErrors[info.agentId] ?? null}
                terminalError={terminalErrors[info.agentId] ?? null}
                onInstall={() => void openSingleConfirm(info.agentId)}
                onCancelInstall={() => cancelInstall(info.agentId)}
                onDismissInstall={() => dismissInstallPanel(info.agentId)}
                onToggleLog={() => setLogOpen((prev) => ({ ...prev, [info.agentId]: !prev[info.agentId] }))}
                onToggleManual={() => setManualOpen((prev) => ({ ...prev, [info.agentId]: !prev[info.agentId] }))}
                onSignIn={() => void startSignIn(info.agentId)}
                onEndSignIn={() => endSignIn(info.agentId)}
                onOpenTerminal={(purpose) => void openTerminalFor(info.agentId, purpose)}
                onSetCustomPath={() => {
                  closeCliSetupScreen()
                  setSettingsViewOpen(true)
                }}
              />
            ))
          )}
        </div>

        <div className="ad-cli-setup__global-actions">
          <Button variant="primary" onClick={() => void openInstallAllConfirm()} disabled={missingCount === 0 || installingAll}>
            {installingAll ? <Spinner size={13} /> : <Download size={14} />}
            Install all missing CLIs
          </Button>
          <Button variant="secondary" onClick={() => void refreshCliSetup()} disabled={cliSetupLoading}>
            <RefreshCw size={14} className={cliSetupLoading ? 'ad-spin' : ''} />
            Check again
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              closeCliSetupScreen()
              setSettingsViewOpen(true)
            }}
          >
            Set custom executable path
          </Button>
          <Button variant="ghost" onClick={() => void dismissCliSetupScreen()}>
            Skip for now
          </Button>
        </div>
      </div>

      {confirmTarget && (
        <Dialog open onClose={() => setConfirmTarget(null)} title="Confirm installation" width={520}>
          <div className="ad-cli-setup__confirm">
            {confirmTarget.mode === 'single' ? (
              <>
                <p>{confirmTarget.plan.summary}</p>
                <code className="ad-cli-setup__command">{confirmTarget.plan.displayCommand}</code>
              </>
            ) : (
              <>
                <p>AgentDock will run the following commands, one at a time:</p>
                {confirmTarget.plans.map((plan) => (
                  <div key={plan.agentId} className="ad-cli-setup__confirm-row">
                    <span>{AGENT_DISPLAY_NAMES[plan.agentId]}</span>
                    <code className="ad-cli-setup__command">{plan.displayCommand}</code>
                  </div>
                ))}
              </>
            )}
            <div className="ad-cli-setup__confirm-actions">
              <Button variant="secondary" onClick={() => setConfirmTarget(null)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void confirmInstall()}>
                Run it
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </Dialog>
  )
}

interface AgentSetupCardProps {
  info: CliSetupInfo
  installRun: InstallRun | null
  logOpen: boolean
  manualOpen: boolean
  signIn: SignInRun | null
  signInError: string | null
  terminalError: string | null
  onInstall: () => void
  onCancelInstall: () => void
  onDismissInstall: () => void
  onToggleLog: () => void
  onToggleManual: () => void
  onSignIn: () => void
  onEndSignIn: () => void
  onOpenTerminal: (purpose: 'install' | 'signIn') => void
  onSetCustomPath: () => void
}

function AgentSetupCard({
  info,
  installRun,
  logOpen,
  manualOpen,
  signIn,
  signInError,
  terminalError,
  onInstall,
  onCancelInstall,
  onDismissInstall,
  onToggleLog,
  onToggleManual,
  onSignIn,
  onEndSignIn,
  onOpenTerminal,
  onSetCustomPath
}: AgentSetupCardProps): React.JSX.Element {
  const meta = STATUS_META[info.status]
  const canInstall = info.status !== 'ready' && info.status !== 'needs-login'

  return (
    <div className="ad-cli-setup-card">
      <div className="ad-cli-setup-card__top">
        <div className="ad-cli-setup-card__title">{AGENT_DISPLAY_NAMES[info.agentId]}</div>
        <Badge tone={meta.tone}>{meta.label}</Badge>
      </div>

      <div className="ad-cli-setup-card__detail">
        {info.detection.installed ? (
          <>
            <div>Version: {info.detection.version ?? 'unknown'}</div>
            <div className="ad-cli-setup-card__path">Path: {info.detection.executablePath}</div>
          </>
        ) : (
          <div className="ad-cli-setup-card__error">{info.detection.error ?? 'Not detected.'}</div>
        )}
      </div>

      {!installRun && (
        <div className="ad-cli-setup-card__actions">
          {canInstall && (
            <Button variant="primary" size="sm" onClick={onInstall} disabled={!info.installSupported} title={!info.installSupported ? info.installSummary : undefined}>
              <Download size={13} />
              Install for me
            </Button>
          )}
          {info.status === 'needs-login' && !signIn && (
            <Button variant="primary" size="sm" onClick={onSignIn}>
              <LogIn size={13} />
              Sign in
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onSetCustomPath}>
            Set custom executable path
          </Button>
          <Button variant="ghost" size="sm" onClick={onToggleManual}>
            {manualOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            View manual installation instructions
          </Button>
        </div>
      )}

      {signInError && <div className="ad-cli-setup-card__error">{signInError}</div>}
      {terminalError && <div className="ad-cli-setup-card__error">{terminalError}</div>}

      {manualOpen && (
        <div className="ad-cli-setup-card__manual">
          <p>{info.manualInstructions}</p>
          <div className="ad-cli-setup-card__manual-actions">
            {info.manualUrl && (
              <Button variant="ghost" size="sm" onClick={() => void getAgentDock().media.openExternalLink(info.manualUrl!)}>
                <ExternalLink size={13} />
                Open documentation
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => onOpenTerminal(info.status === 'needs-login' ? 'signIn' : 'install')}>
              <TerminalIcon size={13} />
              Open terminal
            </Button>
          </div>
        </div>
      )}

      {installRun && (
        <div className="ad-cli-setup-card__run">
          <div className="ad-cli-setup-card__run-status">
            {installRun.running ? (
              <>
                <Spinner size={13} />
                Installing…
              </>
            ) : installRun.outcome?.ok ? (
              <>
                <CheckCircle2 size={14} className="ad-cli-setup-card__ok" />
                Installed successfully.
              </>
            ) : (
              <span className="ad-cli-setup-card__error">
                {installRun.outcome?.cancelled ? 'Installation cancelled.' : (installRun.outcome?.error ?? 'Installation failed.')}
              </span>
            )}
            <div className="ad-cli-setup-card__run-buttons">
              {installRun.running ? (
                <Button variant="ghost" size="sm" onClick={onCancelInstall}>
                  Cancel
                </Button>
              ) : (
                <Button variant="ghost" size="sm" onClick={onDismissInstall}>
                  <X size={13} />
                  Dismiss
                </Button>
              )}
              <IconButton label={logOpen ? 'Hide technical log' : 'Show technical log'} size="sm" onClick={onToggleLog}>
                {logOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              </IconButton>
            </div>
          </div>
          {logOpen && (
            <CliSetupTerminal
              resetKey={installRun.installId}
              interactive={false}
              onData={(cb) =>
                getAgentDock().cliSetup.onInstallProgress(installRun.installId, (event) => {
                  if (event.kind === 'output' && event.text) cb(event.text)
                })
              }
            />
          )}
        </div>
      )}

      {signIn && (
        <div className="ad-cli-setup-card__run">
          <div className="ad-cli-setup-card__run-status">
            Sign in inside the terminal below — AgentDock never sees what you type.
            <div className="ad-cli-setup-card__run-buttons">
              <Button variant="ghost" size="sm" onClick={onEndSignIn}>
                Done
              </Button>
            </div>
          </div>
          <CliSetupTerminal
            resetKey={signIn.ptyId}
            interactive
            onData={(cb) => getAgentDock().cliSetup.onPtyData(signIn.ptyId, cb)}
            write={(data) => getAgentDock().cliSetup.ptyWrite(signIn.ptyId, data)}
            onResize={(cols, rows) => getAgentDock().cliSetup.ptyResize(signIn.ptyId, cols, rows)}
          />
        </div>
      )}
    </div>
  )
}
