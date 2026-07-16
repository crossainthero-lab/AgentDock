import { describe, expect, it } from 'vitest'
import { TerminalScreenBuffer } from '../../src/main/terminal/TerminalScreenBuffer'

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('TerminalScreenBuffer', () => {
  it('reconstructs plain lines from simple writes', async () => {
    const buf = new TerminalScreenBuffer(80, 24)
    buf.write('hello\r\nworld\r\n')
    await wait(20)
    expect(buf.snapshot().lines).toEqual(['hello', 'world'])
  })

  it('resolves a carriage-return progress redraw to the final value, not every intermediate frame', async () => {
    const buf = new TerminalScreenBuffer(80, 24)
    buf.write('Downloading... 10%\r')
    buf.write('Downloading... 55%\r')
    buf.write('Downloading... 100%\r\n')
    await wait(20)
    expect(buf.snapshot().lines).toEqual(['Downloading... 100%'])
  })

  it('resolves out-of-order, cursor-addressed writes into the correct final line', async () => {
    // Real full-screen TUIs (see the captured Codex output referenced in the
    // plan) paint the second half of a line before the first, using
    // absolute cursor positioning. Naive concatenation of raw chunks would
    // scramble this; a real screen buffer resolves it correctly.
    const buf = new TerminalScreenBuffer(80, 24)
    buf.write('\x1b[3;7Hworld')
    buf.write('\x1b[3;1Hhello ')
    await wait(20)
    expect(buf.snapshot().lines[2]).toBe('hello world')
  })

  it('erase-in-line clears redrawn content instead of leaving stale characters behind', async () => {
    const buf = new TerminalScreenBuffer(80, 24)
    buf.write('a very long line of stale text')
    buf.write('\r\x1b[Kshort\r\n')
    await wait(20)
    expect(buf.snapshot().lines).toEqual(['short'])
  })

  it('handles a chunk boundary landing in the middle of a word', async () => {
    const buf = new TerminalScreenBuffer(80, 24)
    buf.write('hel')
    buf.write('lo wor')
    buf.write('ld\r\n')
    await wait(20)
    expect(buf.snapshot().lines).toEqual(['hello world'])
  })

  it('trims trailing blank rows so callers see a stable tail', async () => {
    const buf = new TerminalScreenBuffer(80, 24)
    buf.write('only line\r\n\r\n\r\n')
    await wait(20)
    expect(buf.snapshot().lines).toEqual(['only line'])
  })

  it('strips ANSI color (SGR) codes, leaving plain text', async () => {
    const buf = new TerminalScreenBuffer(80, 24)
    buf.write('\x1b[31mred text\x1b[0m and \x1b[1;32mbold green\x1b[0m\r\n')
    await wait(20)
    expect(buf.snapshot().lines).toEqual(['red text and bold green'])
  })

  it('resolves an ANSI escape sequence split across chunks instead of corrupting the output', async () => {
    const buf = new TerminalScreenBuffer(80, 24)
    // The SGR sequence for red (\x1b[31m) split mid-sequence across two
    // separate write() calls — real PTY output has no guarantee an escape
    // sequence lands whole in a single chunk.
    buf.write('\x1b[3')
    buf.write('1mHello\x1b[0m\r\n')
    await wait(20)
    expect(buf.snapshot().lines).toEqual(['Hello'])
  })
})
