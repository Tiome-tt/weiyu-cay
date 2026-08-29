import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
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

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

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
  it('keeps nested folders collapsed on initial render', async () => {
    const user = userEvent.setup()
    renderTree()

    const project = screen.getByRole('treeitem', { name: '项目 A' })
    const disclosure = screen.getByTestId('folder-disclosure-项目 A')
    expect(project).toHaveAttribute('aria-expanded', 'false')
    expect(disclosure).toHaveAttribute('data-expanded', 'false')
    expect(screen.queryByRole('treeitem', { name: '子项目' })).not.toBeInTheDocument()

    await user.click(project)
    expect(project).toHaveAttribute('aria-expanded', 'true')
    expect(disclosure).toHaveAttribute('data-expanded', 'true')
    expect(screen.getByRole('treeitem', { name: '子项目' })).toBeVisible()
  })

  it('shows a disclosure before lazy folder notes are loaded', () => {
    const leafFolder: Folder = { id: folderA, parentId: null, name: '按需加载', sortOrder: 0 }
    render(
      <FolderTree
        folders={[leafFolder]}
        activeId={null}
        state="ready"
        onSelect={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
        onRename={vi.fn().mockResolvedValue(undefined)}
        onMove={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
        folderContents={() => undefined}
      />,
    )

    expect(screen.getByTestId('folder-disclosure-按需加载')).toHaveAttribute('data-expanded', 'false')
  })

  it('keeps the child branch mounted while toggling a collapse animation state', async () => {
    const user = userEvent.setup()
    renderTree()

    const project = screen.getByRole('treeitem', { name: '项目 A' })
    await user.click(project)
    const group = project.parentElement?.querySelector<HTMLElement>('[data-folder-parent-id="019c0000-0000-7000-8000-000000000041"]')
    if (group === null || group === undefined) throw new Error('child folder group not found')
    expect(group).toHaveAttribute('data-collapsed', 'false')

    await user.click(project)
    expect(group).toHaveAttribute('data-collapsed', 'true')
  })

  it('keeps a selected folder collapsed after one click while its notes refresh', async () => {
    const user = userEvent.setup()
    function ControlledTree() {
      const [activeId, setActiveId] = useState<FolderId | null>(folderA)
      const [folders, setFolders] = useState(rows)
      return (
        <FolderTree
          folders={folders}
          activeId={activeId}
          state="ready"
          onSelect={(id) => {
            setActiveId(id)
            setFolders([...rows])
          }}
          onCreate={vi.fn().mockResolvedValue(undefined)}
          onRename={vi.fn().mockResolvedValue(undefined)}
          onMove={vi.fn().mockResolvedValue(undefined)}
          onDelete={vi.fn().mockResolvedValue(undefined)}
          folderContents={() => undefined}
        />
      )
    }

    render(<ControlledTree />)
    const project = screen.getByRole('treeitem', { name: '项目 A' })
    expect(project).toHaveAttribute('aria-expanded', 'true')
    await user.click(project)

    await waitFor(() => expect(project).toHaveAttribute('aria-expanded', 'false'))
  })

  it('does not reopen an expanded folder when selecting it to collapse', async () => {
    const user = userEvent.setup()
    function ControlledTree() {
      const [activeId, setActiveId] = useState<FolderId | null>(null)
      return (
        <FolderTree
          folders={rows}
          activeId={activeId}
          state="ready"
          onSelect={setActiveId}
          onCreate={vi.fn().mockResolvedValue(undefined)}
          onRename={vi.fn().mockResolvedValue(undefined)}
          onMove={vi.fn().mockResolvedValue(undefined)}
          onDelete={vi.fn().mockResolvedValue(undefined)}
        />
      )
    }

    render(<ControlledTree />)
    const projectA = screen.getByRole('treeitem', { name: '项目 A' })
    await user.click(projectA)
    expect(projectA).toHaveAttribute('aria-expanded', 'true')

    await user.click(screen.getByRole('treeitem', { name: '项目 B' }))
    await user.click(projectA)

    await waitFor(() => expect(projectA).toHaveAttribute('aria-expanded', 'false'))
  })

  it('seeds the collapsed state when folders arrive after the loading render', async () => {
    const props = {
      state: 'ready' as const,
      activeId: null,
      onSelect: vi.fn(),
      onCreate: vi.fn().mockResolvedValue(undefined),
      onRename: vi.fn().mockResolvedValue(undefined),
      onMove: vi.fn().mockResolvedValue(undefined),
      onDelete: vi.fn().mockResolvedValue(undefined),
    }
    const rendered = render(<FolderTree folders={[]} {...props} />)
    rendered.rerender(<FolderTree folders={rows} {...props} />)

    await waitFor(() => expect(screen.getByRole('treeitem', { name: '项目 A' })).toHaveAttribute('aria-expanded', 'false'))
    expect(screen.queryByRole('treeitem', { name: '子项目' })).not.toBeInTheDocument()
  })

  it('keeps root-level notes visible beside collapsed root folders', () => {
    render(
      <FolderTree
        folders={rows}
        activeId={null}
        state="ready"
        onSelect={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
        onRename={vi.fn().mockResolvedValue(undefined)}
        onMove={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
        folderContents={(folderId) => folderId === null ? <span>根目录笔记</span> : folderId === folderA ? <span>项目笔记</span> : undefined}
      />,
    )

    expect(screen.getByText('根目录笔记')).toBeVisible()
    expect(screen.queryByText('项目笔记')).not.toBeInTheDocument()
  })

  it('also collapses a root folder whose notes arrive without child folders', () => {
    const leafFolder: Folder = { id: folderA, parentId: null, name: '项目笔记夹', sortOrder: 0 }
    render(
      <FolderTree
        folders={[leafFolder]}
        activeId={null}
        state="ready"
        onSelect={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
        onRename={vi.fn().mockResolvedValue(undefined)}
        onMove={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
        folderContents={(folderId) => folderId === null ? <span>根目录笔记</span> : <span>项目笔记</span>}
      />,
    )

    expect(screen.getByRole('treeitem', { name: '项目笔记夹' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('根目录笔记')).toBeVisible()
    expect(screen.queryByText('项目笔记')).not.toBeInTheDocument()
  })

  it('opens a folder selected from an external navigation rail', async () => {
    const rendered = render(
      <FolderTree
        folders={rows}
        activeId={null}
        state="ready"
        onSelect={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
        onRename={vi.fn().mockResolvedValue(undefined)}
        onMove={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    rendered.rerender(
      <FolderTree
        folders={rows}
        activeId={folderA}
        state="ready"
        onSelect={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
        onRename={vi.fn().mockResolvedValue(undefined)}
        onMove={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    await waitFor(() => expect(screen.getByRole('treeitem', { name: '项目 A' })).toHaveAttribute('aria-expanded', 'true'))
    expect(screen.getByRole('treeitem', { name: '子项目' })).toBeVisible()
  })

  it('keeps folder mutations inside a selected-folder more menu', async () => {
    const user = userEvent.setup()
    const props = {
      folders: rows,
      state: 'ready' as const,
      onSelect: vi.fn(),
      onCreate: vi.fn().mockResolvedValue(undefined),
      onRename: vi.fn().mockResolvedValue(undefined),
      onMove: vi.fn().mockResolvedValue(undefined),
      onDelete: vi.fn().mockResolvedValue(undefined),
      onCreateNote: vi.fn(),
      onToggleStar: vi.fn().mockResolvedValue(undefined),
    }
    const rendered = render(<FolderTree {...props} activeId={null} />)
    const more = screen.getByRole('button', { name: '文件夹更多操作' })
    expect(more).toBeDisabled()
    expect(screen.queryByRole('button', { name: '重命名文件夹' })).not.toBeInTheDocument()

    rendered.rerender(<FolderTree {...props} activeId={folderA} />)
    expect(more).toBeEnabled()
    await user.click(more)
    expect(screen.getByRole('menuitem', { name: '重命名文件夹' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '移动文件夹' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '删除文件夹' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '添加星标' })).toBeVisible()
    await user.click(screen.getByRole('menuitem', { name: '重命名文件夹' }))
    expect(screen.getByRole('textbox', { name: '重命名文件夹' })).toHaveFocus()
  })

  it('adds a star from the folder context menu', async () => {
    const user = userEvent.setup()
    const onToggleStar = vi.fn().mockResolvedValue(undefined)
    render(<FolderTree folders={rows} activeId={folderA} state="ready" onSelect={vi.fn()} onCreate={vi.fn().mockResolvedValue(undefined)} onRename={vi.fn().mockResolvedValue(undefined)} onMove={vi.fn().mockResolvedValue(undefined)} onDelete={vi.fn().mockResolvedValue(undefined)} onToggleStar={onToggleStar} />)

    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('treeitem', { name: '项目 A' }) })
    await user.click(screen.getByRole('menuitem', { name: '添加星标' }))

    expect(onToggleStar).toHaveBeenCalledWith(folderA, true)
  })

  it('renames a folder from its context menu', async () => {
    const user = userEvent.setup()
    const onRename = vi.fn().mockResolvedValue(undefined)
    render(<FolderTree folders={rows} activeId={null} state="ready" onSelect={vi.fn()} onCreate={vi.fn().mockResolvedValue(undefined)} onRename={onRename} onMove={vi.fn().mockResolvedValue(undefined)} onDelete={vi.fn().mockResolvedValue(undefined)} />)

    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('treeitem', { name: '项目 A' }) })
    await user.click(screen.getByRole('menuitem', { name: '重命名文件夹' }))
    const input = screen.getByRole('textbox', { name: '重命名文件夹' })
    await user.clear(input)
    await user.type(input, '新名称{Enter}')

    expect(onRename).toHaveBeenCalledWith(folderA, '新名称')
  })

  it('creates a note from the folder context menu in that folder', async () => {
    const user = userEvent.setup()
    const onCreateNote = vi.fn()
    render(<FolderTree folders={rows} activeId={folderA} state="ready" onSelect={vi.fn()} onCreate={vi.fn().mockResolvedValue(undefined)} onRename={vi.fn().mockResolvedValue(undefined)} onMove={vi.fn().mockResolvedValue(undefined)} onDelete={vi.fn().mockResolvedValue(undefined)} onCreateNote={onCreateNote} />)

    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('treeitem', { name: '项目 A' }) })
    await user.click(screen.getByRole('menuitem', { name: '新建笔记' }))

    expect(onCreateNote).toHaveBeenCalledWith(folderA)
    expect(screen.queryByRole('menu', { name: '文件夹快捷操作' })).not.toBeInTheDocument()
  })

  it('starts a new child folder from the folder context menu', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn().mockResolvedValue(undefined)
    render(<FolderTree folders={rows} activeId={null} state="ready" onSelect={vi.fn()} onCreate={onCreate} onRename={vi.fn().mockResolvedValue(undefined)} onMove={vi.fn().mockResolvedValue(undefined)} onDelete={vi.fn().mockResolvedValue(undefined)} />)

    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('treeitem', { name: '项目 A' }) })
    await user.click(screen.getByRole('menuitem', { name: '新建文件夹' }))
    await user.type(screen.getByRole('textbox', { name: '文件夹名称' }), '子文件夹{Enter}')

    expect(onCreate).toHaveBeenCalledWith(folderA, '子文件夹')
  })

  it('opens the folder context menu at the pointer location', () => {
    render(<FolderTree folders={rows} activeId={null} state="ready" onSelect={vi.fn()} onCreate={vi.fn().mockResolvedValue(undefined)} onRename={vi.fn().mockResolvedValue(undefined)} onMove={vi.fn().mockResolvedValue(undefined)} onDelete={vi.fn().mockResolvedValue(undefined)} onToggleStar={vi.fn().mockResolvedValue(undefined)} />)

    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '项目 A' }), { clientX: 144, clientY: 88 })

    expect(screen.getByRole('menu', { name: '文件夹快捷操作' })).toHaveStyle({ left: '144px', top: '88px' })
  })

  it('opens the root context menu from blank tree space and creates a top-level folder', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn().mockResolvedValue(undefined)
    render(<FolderTree folders={rows} activeId={null} state="ready" onSelect={vi.fn()} onCreate={onCreate} onRename={vi.fn().mockResolvedValue(undefined)} onMove={vi.fn().mockResolvedValue(undefined)} onDelete={vi.fn().mockResolvedValue(undefined)} onCreateNote={vi.fn()} />)
    const tree = screen.getByRole('tree', { name: '笔记文件夹' })

    fireEvent.contextMenu(tree, { clientX: 210, clientY: 420 })

    expect(screen.getByRole('menu', { name: '文件夹快捷操作' })).toBeVisible()
    expect(screen.queryByRole('menuitem', { name: '重命名文件夹' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: '新建笔记' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: '新建文件夹' }))
    await user.type(screen.getByRole('textbox', { name: '文件夹名称' }), '根目录文件夹{Enter}')

    expect(onCreate).toHaveBeenCalledWith(null, '根目录文件夹')
  })

  it('cancels a new folder draft when focus leaves the input', async () => {
    const user = userEvent.setup()
    renderTree()
    await user.click(screen.getByRole('button', { name: '新建文件夹' }))
    const input = screen.getByRole('textbox', { name: '文件夹名称' })
    await user.click(screen.getByRole('treeitem', { name: '未归档笔记' }))
    expect(input).not.toBeInTheDocument()
  })

  it('asks for confirmation before deleting a folder', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(<FolderTree folders={rows} activeId={folderA} state="ready" onSelect={vi.fn()} onCreate={vi.fn().mockResolvedValue(undefined)} onRename={vi.fn().mockResolvedValue(undefined)} onMove={vi.fn().mockResolvedValue(undefined)} onDelete={onDelete} />)
    await user.click(screen.getByRole('button', { name: '文件夹更多操作' }))
    await user.click(screen.getByRole('menuitem', { name: '删除文件夹' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('文件夹及其全部笔记和子文件夹会移入回收站')
    await user.click(screen.getByRole('button', { name: '删除文件夹' }))
    expect(onDelete).toHaveBeenCalledWith(folderA)
  })

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
    expect(inbox).toContainElement(screen.getByTestId('icon-inbox'))
    await user.click(inbox)
    expect(onTemporaryInbox).toHaveBeenCalledOnce()
  })

  it('uses shared SVG icons while preserving navigation accessible names', () => {
    render(
      <FolderTree
        folders={rows}
        activeId={null}
        state="ready"
        onSelect={vi.fn()}
        onTemporaryInbox={vi.fn()}
        onTrash={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
        onRename={vi.fn().mockResolvedValue(undefined)}
        onMove={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    expect(screen.getByRole('treeitem', { name: '未归档笔记' })).toContainElement(screen.getAllByTestId('icon-folder')[0])
    expect(screen.getByRole('treeitem', { name: '项目 A' })).toContainElement(screen.getAllByTestId('icon-folder')[1])
    expect(screen.getByRole('treeitem', { name: '临时收集箱' })).toContainElement(screen.getByTestId('icon-inbox'))
    expect(screen.getByRole('treeitem', { name: '回收站' })).toContainElement(screen.getByTestId('icon-trash'))
  })

  it('uses roving focus with vertical and hierarchy-aware arrow navigation', async () => {
    const user = userEvent.setup()
    renderTree()
    const root = screen.getByRole('treeitem', { name: '未归档笔记' })
    const project = screen.getByRole('treeitem', { name: '项目 A' })
    const last = screen.getByRole('treeitem', { name: '项目 B' })

    expect(screen.getAllByRole('treeitem').map((item) => item.tabIndex)).toEqual([0, -1, -1])
    root.focus()
    await user.keyboard('{ArrowDown}')
    expect(project).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    const child = screen.getByRole('treeitem', { name: '子项目' })
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

  it('hands menu move focus to the existing destination form', async () => {
    const user = userEvent.setup()
    render(
      <FolderTree
        folders={rows}
        activeId={folderA}
        state="ready"
        onSelect={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
        onRename={vi.fn().mockResolvedValue(undefined)}
        onMove={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    await user.click(screen.getByRole('button', { name: '文件夹更多操作' }))
    await user.click(screen.getByRole('menuitem', { name: '移动文件夹' }))

    expect(screen.getByRole('combobox', { name: '移动到' })).toHaveFocus()
  })

  it('moves final focus to unfiled after an asynchronous selected-folder deletion', async () => {
    const pending = deferred()
    const onDelete = vi.fn()
    function DeleteHarness() {
      const [folders, setFolders] = useState(rows)
      const [activeId, setActiveId] = useState<FolderId | null>(folderB)
      return (
        <FolderTree
          folders={folders}
          activeId={activeId}
          state="ready"
          onSelect={setActiveId}
          onCreate={vi.fn().mockResolvedValue(undefined)}
          onRename={vi.fn().mockResolvedValue(undefined)}
          onMove={vi.fn().mockResolvedValue(undefined)}
          onDelete={async (id) => {
            onDelete(id)
            await pending.promise
            setFolders((current) => current.filter((folder) => folder.id !== id))
            setActiveId(null)
          }}
        />
      )
    }
    const user = userEvent.setup()
    render(<DeleteHarness />)
    const more = screen.getByRole('button', { name: '文件夹更多操作' })

    await user.click(more)
    await user.click(screen.getByRole('menuitem', { name: '删除文件夹' }))
    await user.click(screen.getByRole('button', { name: '删除文件夹' }))
    expect(onDelete).toHaveBeenCalledWith(folderB)

    await act(async () => pending.resolve())
    const unfiled = screen.getByRole('treeitem', { name: '未归档笔记' })
    await waitFor(() => expect(unfiled).toHaveFocus())
    expect(unfiled).toHaveAttribute('aria-selected', 'true')
    expect(more).toBeDisabled()
  })
})
