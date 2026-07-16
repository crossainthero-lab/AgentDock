import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Copy, ListTree, Square, TerminalSquare, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getAgentDock } from '../../lib/agentDockClient'
import type { TerminalExitInfo } from '@shared/types'
import type { TraceEvent } from '@shared/events/trace-event'
import { IconButton } from '../ui/IconButton'
import './TerminalDrawer.css'

interface TerminalDrawerProps {
  open: boolean
  onClose: () => void
  sessionId: string
  inputSupported: boolean
  isRunning: boolean
  /** Debug instrumentation (the "Testing Mode" requirement) — a bounded
   *  ring buffer owned by the session store (useSessionConversation), never
   *  fetched/reconstructed here. Shows where a message/event originated:
   *  PTY, classifier, IPC, or the renderer store. */
  traces: TraceEvent[]
}

function formatTrace(t: TraceEvent): string {
  const parts = [new Date(t.timestamp).toLocaleTimeString(), t.kind]
  if (t.turnId) parts.push(`turn:${t.turnId.slice(0, 8)}`)
  if (t.sequence != null) parts.push(`#${t.sequence}`)
  if (t.detail) parts.push(t.detail)
  return parts.join('  ·  ')
}

function readThemeColors(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const styles = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback
  return {
    background: read('--color-bg-app', '#101114'),
    foreground: read('--color-text-primary', '#e9eaed'),
    cursor: read('--color-accent', '#5b8def'),
    selectionBackground: read('--color-bg-selected', 'rgba(91, 141, 239, 0.25)')
  }
}

/**
 * A real terminal emulator (xterm.js) attached to the same live PTY backing
 * the session's conversation — not a separate shell. It renders whatever
 * `terminal:data` delivers (ANSI, cursor movement, CR progress lines,
 * partial chunks, Unicode) faithfully, and forwards every keystroke straight
 * into the PTY's stdin.
 */
export function TerminalDrawer({ open, onClose, sessionId, inputSupported, isRunning, traces }: TerminalDrawerProps): React.JSX.Element | null {
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollbackRef = useRef('')
  const [exitInfo, setExitInfo] = useState<TerminalExitInfo | null>(null)
  const [view, setView] = useState<'terminal' | 'trace'>('terminal')

  useEffect(() => {
    if (!open || !containerRef.current) return
    setExitInfo(null)
    scrollbackRef.current = ''

    const term = new Terminal({
      convertEol: true,
      fontFamily: "'Cascadia Code', 'SF Mono', Consolas, 'Liberation Mono', monospace",
      fontSize: 12,
      lineHeight: 1.35,
      cursorBlink: inputSupported,
      disableStdin: !inputSupported,
      theme: readThemeColors()
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    fitAddon.fit()

    const offData = getAgentDock().terminal.onData(sessionId, (chunk) => {
      term.write(chunk)
      scrollbackRef.current += chunk
    })
    const offExit = getAgentDock().terminal.onExit(sessionId, (info) => {
      setExitInfo(info)
    })

    const inputSubscription = inputSupported
      ? term.onData((data) => {
          getAgentDock().terminal.write(sessionId, data)
        })
      : null

    function notifyResize(): void {
      fitAddon.fit()
      getAgentDock().terminal.resize(sessionId, term.cols, term.rows)
    }
    const resizeObserver = new ResizeObserver(notifyResize)
    resizeObserver.observe(containerRef.current)
    notifyResize()

    return () => {
      offData()
      offExit()
      inputSubscription?.dispose()
      resizeObserver.disconnect()
      term.dispose()
    }
  }, [open, sessionId, inputSupported])

  if (!open) return null

  return (
    <div className="ad-terminal-drawer">
      <div className="ad-terminal-drawer__header">
        <span>{view === 'terminal' ? 'Terminal Output' : `Event Trace (${traces.length})`}</span>
        <div className="ad-terminal-drawer__header-actions">
          <IconButton
            label={view === 'terminal' ? 'Show event trace' : 'Show terminal'}
            size="sm"
            onClick={() => setView((v) => (v === 'terminal' ? 'trace' : 'terminal'))}
          >
            {view === 'terminal' ? <ListTree size={13} /> : <TerminalSquare size={13} />}
          </IconButton>
          {isRunning && (
            <IconButton label="Interrupt" size="sm" onClick={() => getAgentDock().terminal.interrupt(sessionId)}>
              <Square size={13} />
            </IconButton>
          )}
          <IconButton label="Copy all output" size="sm" onClick={() => void navigator.clipboard.writeText(scrollbackRef.current)}>
            <Copy size={13} />
          </IconButton>
          <IconButton label="Close" size="sm" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>
      </div>

      <div className="ad-terminal-drawer__body" ref={containerRef} style={{ display: view === 'terminal' ? undefined : 'none' }} />
      {view === 'trace' && (
        <div className="ad-terminal-drawer__trace">
          {traces.length === 0 ? (
            <div className="ad-terminal-drawer__trace-empty">No events yet for this session.</div>
          ) : (
            traces.map((t, i) => (
              <div key={i} className="ad-terminal-drawer__trace-row">
                {formatTrace(t)}
              </div>
            ))
          )}
        </div>
      )}

      {exitInfo && (
        <div className={`ad-terminal-drawer__exit${exitInfo.exitCode === 0 ? '' : ' ad-terminal-drawer__exit--error'}`}>
          Process exited{exitInfo.exitCode != null ? ` with code ${exitInfo.exitCode}` : ''}
          {exitInfo.signal ? ` (signal ${exitInfo.signal})` : ''}
        </div>
      )}
    </div>
  )
}
