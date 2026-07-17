// ANTIGRAVITY-ONLY (see TerminalSessionController.ts's module comment).
// Reconstructs the terminal's actual visible screen from raw PTY bytes,
// instead of regexing raw chunks. Output can redraw lines, erase text, move
// the cursor, split words/escape sequences across chunks, and repeat
// content — a real VT parser is the only reliable way to get a stable
// picture of "what does the screen show right now". Backed by
// @xterm/headless (DOM-free build of the same engine already used by the
// renderer's TerminalDrawer, so behavior matches what a user sees there).
import { Terminal } from '@xterm/headless'

export interface ScreenSnapshot {
  /** Visible rows as plain text, trailing blank rows trimmed. */
  lines: string[]
  /** Absolute row index into `lines` (not viewport-relative) — a status/
   *  spinner area near the bottom of a real TUI is cursor-addressed and
   *  redraws in place rather than scrolling, so classifiers use this to
   *  tell "permanent scrollback history" (rows before the cursor) apart
   *  from "the live status area" (at/after the cursor's row). */
  cursorRow: number
  cursorCol: number
  /** True when the cursor sits at the start of a fresh row just past the
   *  last line of content — i.e. output looks "settled" (prose finished
   *  printing) rather than sitting mid-box/mid-prompt waiting for input. */
  atRestingPosition: boolean
  /** Raw bytes written since the previous snapshot (diagnostics / fallback). */
  raw: string
}

export class TerminalScreenBuffer {
  private readonly term: Terminal
  private rawSinceSnapshot = ''

  constructor(cols = 120, rows = 30) {
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 })
  }

  write(chunk: string): void {
    this.rawSinceSnapshot += chunk
    this.term.write(chunk)
  }

  resize(cols: number, rows: number): void {
    try {
      this.term.resize(cols, rows)
    } catch {
      // ignore — resize can race a still-initializing buffer
    }
  }

  /** Reads the current stable state. Only meaningful once the writer has
   *  been idle long enough for xterm's internal write queue to drain
   *  (the idle debounce in TerminalSessionController guarantees this). */
  snapshot(): ScreenSnapshot {
    const buf = this.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i)
      if (line) lines.push(line.translateToString(true))
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()

    const cursorCol = buf.cursorX
    // baseY is the absolute row where the viewport currently starts, so
    // baseY + cursorY converts the viewport-relative cursor into the same
    // absolute row space as `lines` (built from row 0 of the whole buffer).
    const cursorRow = buf.baseY + buf.cursorY
    const lastContentRow = lines.length - 1
    const atRestingPosition = cursorCol <= 1 && cursorRow >= lastContentRow

    const raw = this.rawSinceSnapshot
    this.rawSinceSnapshot = ''
    return { lines, cursorRow, cursorCol, atRestingPosition, raw }
  }

  dispose(): void {
    this.term.dispose()
  }
}
