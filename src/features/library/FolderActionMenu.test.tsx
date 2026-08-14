import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FolderActionMenu } from './FolderActionMenu'

afterEach(cleanup)

describe('FolderActionMenu', () => {
  it('enables the more trigger only when a folder is selected', () => {
    const rendered = render(
      <FolderActionMenu enabled={false} onRename={vi.fn()} onMove={vi.fn()} onDelete={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: '文件夹更多操作' })).toBeDisabled()

    rendered.rerender(
      <FolderActionMenu enabled onRename={vi.fn()} onMove={vi.fn()} onDelete={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: '文件夹更多操作' })).toBeEnabled()
  })

  it('opens from the keyboard and moves focus through its actions', async () => {
    const onMove = vi.fn()
    const user = userEvent.setup()
    render(<FolderActionMenu enabled onRename={vi.fn()} onMove={onMove} onDelete={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: '文件夹更多操作' })
    trigger.focus()

    await user.keyboard('{Enter}')
    expect(screen.getByRole('menuitem', { name: '重命名文件夹' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: '移动文件夹' })).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(onMove).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('marks deletion as dangerous while delegating the existing safe callback', async () => {
    const onDelete = vi.fn()
    const user = userEvent.setup()
    render(<FolderActionMenu enabled onRename={vi.fn()} onMove={vi.fn()} onDelete={onDelete} />)

    await user.click(screen.getByRole('button', { name: '文件夹更多操作' }))
    const deletion = screen.getByRole('menuitem', { name: '删除空文件夹' })
    expect(deletion).toHaveAttribute('data-variant', 'danger')
    await user.click(deletion)

    expect(onDelete).toHaveBeenCalledOnce()
  })
})
