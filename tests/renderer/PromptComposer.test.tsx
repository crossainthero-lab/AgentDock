import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PromptComposer } from '../../src/renderer/components/session/PromptComposer'

describe('PromptComposer', () => {
  it('disables sending when the composer is disabled and shows the reason as a title', () => {
    render(
      <PromptComposer disabled disabledReason="Codex is not installed." isRunning={false} onSend={vi.fn()} onInterrupt={vi.fn()} />
    )
    const textarea = screen.getByPlaceholderText('Codex is not installed.')
    expect(textarea).toBeDisabled()
  })

  it('disables the send button when the task text is empty', () => {
    const { container } = render(
      <PromptComposer disabled={false} disabledReason={null} isRunning={false} onSend={vi.fn()} onInterrupt={vi.fn()} />
    )
    const sendButton = container.querySelector('.ad-composer__send')
    expect(sendButton).toBeDisabled()
  })

  it('calls onSend with the trimmed text and clears the field on Enter', () => {
    const onSend = vi.fn()
    render(<PromptComposer disabled={false} disabledReason={null} isRunning={false} onSend={onSend} onInterrupt={vi.fn()} />)
    const textarea = screen.getByPlaceholderText('Tell the agent what to do…') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '  do the thing  ' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('do the thing')
    expect(textarea.value).toBe('')
  })

  it('does not send on Shift+Enter (inserts a newline instead)', () => {
    const onSend = vi.fn()
    render(<PromptComposer disabled={false} disabledReason={null} isRunning={false} onSend={onSend} onInterrupt={vi.fn()} />)
    const textarea = screen.getByPlaceholderText('Tell the agent what to do…')
    fireEvent.change(textarea, { target: { value: 'line one' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows Stop instead of Send while running, and calls onInterrupt', () => {
    const onInterrupt = vi.fn()
    render(<PromptComposer disabled={false} disabledReason={null} isRunning onSend={vi.fn()} onInterrupt={onInterrupt} />)
    const stopButton = screen.getByText('Stop')
    fireEvent.click(stopButton)
    expect(onInterrupt).toHaveBeenCalled()
  })
})
