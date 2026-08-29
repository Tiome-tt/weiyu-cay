import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DirectoryRail } from './DirectoryRail'
import { LibraryRail } from './LibraryRail'
import type { FolderId } from '../../domain/model'

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

  it('hides a formal-note count when the active view has no note directory', () => {
    render(<DirectoryRail count={null} onExpand={vi.fn()} />)

    const rail = screen.getByRole('button', { name: '展开目录' })
    expect(rail).toHaveTextContent('目录')
    expect(rail).not.toHaveTextContent('·')
    expect(rail).not.toHaveAccessibleName(/篇笔记/)
  })

  it('keeps library destinations functional and marks the current entry independently', async () => {
    const onUnfiled = vi.fn()
    const onTemporary = vi.fn()
    const onTrash = vi.fn()
    const onExpand = vi.fn()
    const user = userEvent.setup()
    render(
      <LibraryRail
        activeEntry="temporary"
        onTemporary={onTemporary}
        onTrash={onTrash}
        onExpand={onExpand}
      />,
    )

    expect(screen.getByRole('navigation', { name: '折叠的资料库' })).toHaveStyle({ width: '42px' })
    expect(screen.getByRole('button', { name: '临时收集箱' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: '临时收集箱' })).toContainElement(screen.getByTestId('icon-inbox'))

    await user.click(screen.getByRole('button', { name: '临时收集箱' }))
    await user.click(screen.getByRole('button', { name: '回收站' }))
    await user.click(screen.getByRole('button', { name: '展开资料库' }))

    expect(onUnfiled).toHaveBeenCalledTimes(0)
    expect(onTemporary).toHaveBeenCalledTimes(1)
    expect(onTrash).toHaveBeenCalledTimes(1)
    expect(onExpand).toHaveBeenCalledTimes(1)
  })

  it('shows up to six starred folders and an overflow entry with descriptive labels', async () => {
    const starred = Array.from({ length: 7 }, (_, index) => ({
      id: `019c0000-0000-7000-8000-0000000000${50 + index}` as FolderId,
      parentId: null,
      name: `星标 ${index + 1}`,
      sortOrder: index,
    }))
    const onFolder = vi.fn()
    const onMore = vi.fn()
    render(<LibraryRail activeEntry="folder" activeFolderId={starred[0].id} starredFolders={starred} onUnfiled={vi.fn()} onFolder={onFolder} onMoreFolders={onMore} onExpand={vi.fn()} />)

    expect(screen.getAllByRole('button', { name: /^星标 [1-6]$/ })).toHaveLength(6)
    expect(screen.getByRole('button', { name: '更多星标文件夹' })).toBeVisible()
    await userEvent.setup().click(screen.getByRole('button', { name: '星标 3' }))
    expect(onFolder).toHaveBeenCalledWith(starred[2].id)
  })
})
