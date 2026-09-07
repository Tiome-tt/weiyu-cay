import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloseBehaviorDialog } from './CloseBehaviorDialog'

describe('CloseBehaviorDialog', () => {
  afterEach(cleanup)

  it('uses a concise close question while preserving the tray outcome', () => {
    render(<CloseBehaviorDialog busy={false} error={null} onCancel={vi.fn()} onChoose={vi.fn()} />)

    expect(screen.getByRole('dialog', { name: '关闭窗口？' })).toHaveAccessibleDescription(
      '微屿将继续在后台运行，可从系统托盘再次打开。',
    )
  })

  it('defaults to remembering a safe close-to-tray choice', async () => {
    const onChoose = vi.fn()
    const user = userEvent.setup()
    render(<CloseBehaviorDialog busy={false} error={null} onCancel={vi.fn()} onChoose={onChoose} />)

    expect(screen.getByRole('dialog', { name: '关闭窗口？' })).toBeVisible()
    expect(screen.getByLabelText('记住我的选择')).toBeChecked()
    await user.click(screen.getByRole('button', { name: '隐藏到托盘' }))

    expect(onChoose).toHaveBeenCalledWith('hide', true)
  })

  it('supports a one-time choice and an explicit exit', async () => {
    const onChoose = vi.fn()
    const user = userEvent.setup()
    render(<CloseBehaviorDialog busy={false} error={null} onCancel={vi.fn()} onChoose={onChoose} />)

    await user.click(screen.getByLabelText('记住我的选择'))
    await user.click(screen.getByRole('button', { name: '退出微屿' }))

    expect(onChoose).toHaveBeenCalledWith('exit', false)
  })

  it('cancels with Escape but cannot dismiss during persistence', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    const view = render(<CloseBehaviorDialog busy={false} error={null} onCancel={onCancel} onChoose={vi.fn()} />)

    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledOnce()

    view.rerender(<CloseBehaviorDialog busy error="设置未能保存，窗口保持打开。" onCancel={onCancel} onChoose={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('设置未能保存')
    expect(screen.getByRole('button', { name: '隐藏到托盘' })).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('never offers hiding when the native tray recovery entry is unavailable', () => {
    render(<CloseBehaviorDialog trayAvailable={false} busy={false} error={null} onCancel={vi.fn()} onChoose={vi.fn()} />)

    expect(screen.getByRole('button', { name: '隐藏到托盘' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('系统托盘暂不可用')
    expect(screen.getByRole('button', { name: '退出微屿' })).toBeEnabled()
  })
})
