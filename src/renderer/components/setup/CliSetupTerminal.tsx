import type React from 'react'
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './CliSetupTerminal.css'

interface CliSetupTerminalProps {
  /** Subscribes to output chunks — the caller decides the source (install
   *  progress events filtered to `kind: 'output'`, or a live sign-in PTY's
   *  raw data stream). Called once per mount/resetKey change. */
  onData: (cb: (chunk: string) => void) => () => void
  /** Present only for an interactive session (sign-in) — omit for a
   *  read-only install log view. */
  write?: (data: string) => void
  onResize?: (cols: number, rows: number) => void
  interactive: boolean
  /** Remounts the underlying xterm instance when it changes — pass the
   *  installId/ptyId so switching to a different run never mixes output
   *  from two different processes into the same terminal buffer. */
  resetKey: string
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

/** A real terminal emulator (xterm.js) fed by whatever `onData` subscribes
 *  to — used both for the CLI Setup Assistant's read-only install-progress
 *  log (real PTY output, so ANSI colors/progress bars render correctly
 *  instead of showing raw escape codes) and its interactive sign-in panel. */
export function CliSetupTerminal({ onData, write, onResize, interactive, resetKey }: CliSetupTerminalProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      convertEol: true,
      fontFamily: "'Cascadia Code', 'SF Mono', Consolas, 'Liberation Mono', monospace",
      fontSize: 12,
      lineHeight: 1.35,
      cursorBlink: interactive,
      disableStdin: !interactive,
      theme: readThemeColors()
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    fitAddon.fit()

    const offData = onData((chunk) => term.write(chunk))
    const inputSubscription = interactive && write ? term.onData((data) => write(data)) : null

    function notifyResize(): void {
      fitAddon.fit()
      onResize?.(term.cols, term.rows)
    }
    const resizeObserver = new ResizeObserver(notifyResize)
    resizeObserver.observe(containerRef.current)
    notifyResize()

    return () => {
      offData()
      inputSubscription?.dispose()
      resizeObserver.disconnect()
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed only by resetKey/interactive; onData/write/onResize are stable closures the caller re-creates per resetKey.
  }, [resetKey, interactive])

  return <div className="ad-cli-setup-terminal" ref={containerRef} />
}
