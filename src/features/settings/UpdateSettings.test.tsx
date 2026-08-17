import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateController } from './UpdateSettings'
import { UpdateSettings } from './UpdateSettings'

describe('UpdateSettings', () => {
  afterEach(cleanup)

  it('keeps checking explicit and reports a recoverable check failure', async () => {
    const check = vi.fn().mockResolvedValue(undefined)
    const controller: UpdateController = {
      state: { status: 'check-error' },
      check,
      install: vi.fn(),
      restart: vi.fn(),
    }
    const user = userEvent.setup()
    render(<UpdateSettings controller={controller} />)

    expect(check).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('笔记不会受到影响')
    await user.click(screen.getByRole('button', { name: '重新检查更新' }))
    expect(check).toHaveBeenCalledOnce()
  })

  it('requires separate user actions to install and restart an available update', async () => {
    const install = vi.fn().mockResolvedValue(undefined)
    const restart = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    const controller: UpdateController = {
      state: { status: 'available', update: { version: '0.1.1', notes: '安全修复' } },
      check: vi.fn(),
      install,
      restart,
    }
    const rendered = render(<UpdateSettings controller={controller} />)

    expect(screen.getByText('安全修复')).toBeVisible()
    expect(restart).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '下载并安装 0.1.1' }))
    expect(install).toHaveBeenCalledOnce()
    expect(restart).not.toHaveBeenCalled()

    rendered.rerender(<UpdateSettings controller={{ ...controller, state: { status: 'installed', update: { version: '0.1.1', notes: null } } }} />)
    await user.click(screen.getByRole('button', { name: '重启以完成更新' }))
    expect(restart).toHaveBeenCalledOnce()
  })
})
