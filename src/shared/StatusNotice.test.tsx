import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { StatusNotice } from './StatusNotice'

describe('StatusNotice', () => {
  it('announces a persistent error and exposes retry to keyboard users', async () => {
    const retry = vi.fn()
    const user = userEvent.setup()

    render(<StatusNotice state={{ status: 'error', message: '磁盘空间不足', retry }} />)

    expect(screen.getByRole('alert')).toHaveTextContent('磁盘空间不足')
    await user.tab()
    expect(screen.getByRole('button', { name: '重试保存' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(retry).toHaveBeenCalledOnce()
  })

  it('uses a polite live status for successful durable work', () => {
    render(<StatusNotice state={{ status: 'success', message: '已保存' }} />)

    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByRole('status')).toHaveTextContent('已保存')
  })
})
