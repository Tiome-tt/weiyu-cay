import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DirectoryRail } from './DirectoryRail'
import { LibraryRail } from './LibraryRail'

afterEach(cleanup)

describe('collapsed library rails', () => {
  it('labels the collapsed note list as directory and restores it by keyboard', async () => {
    const onExpand = vi.fn()
    const user = userEvent.setup()
    render(<DirectoryRail count={6} onExpand={onExpand} />)

    const rail = screen.getByRole('button', { name: '展开目录，6 篇笔记' })
    expect(rail).toHaveTextContent('目录 · 6')
    expect(rail).toHaveStyle({ width: '30px' })
    await user.keyboard('{Tab}{Enter}')
    expect(onExpand).toHaveBeenCalledTimes(1)
  })

  it('keeps library destinations functional and marks the current entry independently', async () => {
    const onUnfiled = vi.fn()
    const onFolders = vi.fn()
    const onTemporary = vi.fn()
    const onTrash = vi.fn()
    const onExpand = vi.fn()
    const user = userEvent.setup()
    render(
      <LibraryRail
        activeEntry="folders"
        onUnfiled={onUnfiled}
        onFolders={onFolders}
        onTemporary={onTemporary}
        onTrash={onTrash}
        onExpand={onExpand}
      />,
    )

    expect(screen.getByRole('navigation', { name: '折叠的资料库' })).toHaveStyle({ width: '42px' })
    expect(screen.getByRole('button', { name: '文件夹' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: '未归档笔记' })).not.toHaveAttribute('aria-current')

    await user.click(screen.getByRole('button', { name: '未归档笔记' }))
    await user.click(screen.getByRole('button', { name: '临时收集箱' }))
    await user.click(screen.getByRole('button', { name: '回收站' }))
    await user.click(screen.getByRole('button', { name: '展开资料库' }))

    expect(onUnfiled).toHaveBeenCalledTimes(1)
    expect(onFolders).not.toHaveBeenCalled()
    expect(onTemporary).toHaveBeenCalledTimes(1)
    expect(onTrash).toHaveBeenCalledTimes(1)
    expect(onExpand).toHaveBeenCalledTimes(1)
  })
})
