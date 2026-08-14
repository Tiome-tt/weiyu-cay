import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Folder, FolderId } from '../../domain/model'
import { FolderTree } from './FolderTree'

const folderA = '019c0000-0000-7000-8000-000000000041' as FolderId
const childA = '019c0000-0000-7000-8000-000000000042' as FolderId
const folderB = '019c0000-0000-7000-8000-000000000043' as FolderId
const rows: Folder[] = [
  { id: folderA, parentId: null, name: '项目 A', sortOrder: 0 },
  { id: childA, parentId: folderA, name: '子项目', sortOrder: 0 },
  { id: folderB, parentId: null, name: '项目 B', sortOrder: 1 },
]

function renderTree(overrides: { onSelect?: (id: FolderId | null) => void; onMove?: (id: FolderId, parentId: FolderId | null) => Promise<void> } = {}) {
  const onSelect = overrides.onSelect ?? vi.fn()
  const onMove = overrides.onMove ?? vi.fn().mockResolvedValue(undefined)
  render(
    <FolderTree
      folders={rows}
      activeId={null}
      state="ready"
      onSelect={onSelect}
      onCreate={vi.fn().mockResolvedValue(undefined)}
      onRename={vi.fn().mockResolvedValue(undefined)}
      onMove={onMove}
      onDelete={vi.fn().mockResolvedValue(undefined)}
    />,
  )
  return { onSelect, onMove }
}

afterEach(cleanup)

describe('FolderTree keyboard navigation', () => {
  it('offers a labelled header control that collapses only the library column', async () => {
    const onCollapse = vi.fn()
    const user = userEvent.setup()
    render(
      <FolderTree
        folders={rows}
        activeId={null}
        state="ready"
        onSelect={vi.fn()}
        onCollapse={onCollapse}
        onCreate={vi.fn().mockResolvedValue(undefined)}
        onRename={vi.fn().mockResolvedValue(undefined)}
        onMove={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    await user.click(screen.getByRole('button', { name: '折叠资料库' }))
    expect(onCollapse).toHaveBeenCalledTimes(1)
  })

  it('offers the application trash as a special keyboard-accessible navigation item', async () => {
    const user = userEvent.setup()
    const onTrash = vi.fn()
    render(
      <FolderTree
        folders={rows}
        activeId={null}
        state="ready"
        onSelect={vi.fn()}
        onTrash={onTrash}
        trashActive
        onCreate={vi.fn().mockResolvedValue(undefined)}
        onRename={vi.fn().mockResolvedValue(undefined)}
        onMove={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    const trash = screen.getByRole('treeitem', { name: '回收站' })
    expect(trash).toHaveAttribute('aria-selected', 'true')
    trash.focus()
    await user.keyboard('{Enter}')
    expect(onTrash).toHaveBeenCalledOnce()
  })

  it('offers the temporary inbox as a special navigation item without a folder id', async () => {
    const user = userEvent.setup()
    const onTemporaryInbox = vi.fn()
    render(
      <FolderTree
        folders={rows}
        activeId={null}
        state="ready"
        onSelect={vi.fn()}
        onTemporaryInbox={onTemporaryInbox}
        temporaryInboxActive
        onCreate={vi.fn().mockResolvedValue(undefined)}
        onRename={vi.fn().mockResolvedValue(undefined)}
        onMove={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    const inbox = screen.getByRole('treeitem', { name: '临时收集箱' })
    expect(inbox).toHaveAttribute('aria-selected', 'true')
    await user.click(inbox)
    expect(onTemporaryInbox).toHaveBeenCalledOnce()
  })

  it('uses roving focus with vertical and hierarchy-aware arrow navigation', async () => {
    const user = userEvent.setup()
    renderTree()
    const root = screen.getByRole('treeitem', { name: '未归档笔记' })
    const project = screen.getByRole('treeitem', { name: '项目 A' })
    const child = screen.getByRole('treeitem', { name: '子项目' })
    const last = screen.getByRole('treeitem', { name: '项目 B' })

    expect(screen.getAllByRole('treeitem').map((item) => item.tabIndex)).toEqual([0, -1, -1, -1])
    root.focus()
    await user.keyboard('{ArrowDown}')
    expect(project).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(child).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(project).toHaveFocus()
    await user.keyboard('{End}')
    expect(last).toHaveFocus()
    await user.keyboard('{Home}')
    expect(root).toHaveFocus()
  })

  it('activates a focused folder with the keyboard and communicates selection', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const { rerender } = render(
      <FolderTree
        folders={rows}
        activeId={null}
        state="ready"
        onSelect={onSelect}
        onCreate={vi.fn().mockResolvedValue(undefined)}
        onRename={vi.fn().mockResolvedValue(undefined)}
        onMove={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
      />,
    )
    const project = screen.getByRole('treeitem', { name: '项目 A' })
    project.focus()
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith(folderA)

    rerender(
      <FolderTree
        folders={rows}
        activeId={folderA}
        state="ready"
        onSelect={onSelect}
        onCreate={vi.fn().mockResolvedValue(undefined)}
        onRename={vi.fn().mockResolvedValue(undefined)}
        onMove={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
      />,
    )
    expect(screen.getByRole('treeitem', { name: '项目 A' })).toHaveAttribute('aria-selected', 'true')
  })

  it('moves a folder through a keyboard-only workflow without offering descendants', async () => {
    const user = userEvent.setup()
    const onMove = vi.fn().mockResolvedValue(undefined)
    renderTree({ onMove })
    const project = screen.getByRole('treeitem', { name: '项目 A' })
    project.focus()

    await user.keyboard('{Control>}m{/Control}')
    const destination = await screen.findByRole('combobox', { name: '移动到' })
    expect(screen.queryByRole('option', { name: '子项目' })).not.toBeInTheDocument()
    await user.selectOptions(destination, folderB)
    await user.tab()
    await user.keyboard('{Enter}')

    expect(onMove).toHaveBeenCalledWith(folderA, folderB)
  })
})
