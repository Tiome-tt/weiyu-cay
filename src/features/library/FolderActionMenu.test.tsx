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
    const items = screen.getAllByRole('menuitem')
    expect(items.map((item) => item.tabIndex)).toEqual([0, -1, -1])
    expect(items[0]).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(items.map((item) => item.tabIndex)).toEqual([-1, 0, -1])
    expect(items[1]).toHaveFocus()
    await user.keyboard('{End}')
    expect(items[2]).toHaveFocus()
    await user.keyboard('{Home}')
    expect(items[0]).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')

    expect(onMove).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('restores the trigger on Escape and closes while Tab moves to the next control', async () => {
    const user = userEvent.setup()
    render(<>
      <button type="button">上一个控件</button>
      <FolderActionMenu enabled onRename={vi.fn()} onMove={vi.fn()} onDelete={vi.fn()} />
      <button type="button">下一个控件</button>
    </>)
    const trigger = screen.getByRole('button', { name: '文件夹更多操作' })

    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    await user.keyboard('{Enter}')
    await user.tab()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下一个控件' })).toHaveFocus()

    trigger.focus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitem', { name: '删除空文件夹' })).toHaveFocus()
    await user.keyboard('{Escape}')

    await user.keyboard('{Enter}')
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '上一个控件' })).toHaveFocus()
  })

  it('marks deletion as dangerous while delegating the existing safe callback', async () => {
    const onDelete = vi.fn()
    const user = userEvent.setup()
    render(<FolderActionMenu enabled onRename={vi.fn()} onMove={vi.fn()} onDelete={onDelete} />)

    await user.click(screen.getByRole('button', { name: '文件夹更多操作' }))
    const deletion = screen.getByRole('menuitem', { name: '删除空文件夹' })
    expect(deletion).toHaveAttribute('data-variant', 'danger')
    deletion.focus()
    await user.keyboard('{Enter}')

    expect(onDelete).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '文件夹更多操作' })).toHaveFocus()
  })
})
