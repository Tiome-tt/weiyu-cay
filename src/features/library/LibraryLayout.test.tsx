import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Folder, FolderId, NoteDocument, NoteId, NoteSummary } from '../../domain/model'
import { commandError } from '../../domain/errors'
import { fakeFolderPort, fakeNotePort, fakeSystemPort, note } from '../../test/fakes'
import { LibraryLayout } from './LibraryLayout'

const folderA = '019c0000-0000-7000-8000-000000000021' as FolderId
const folderB = '019c0000-0000-7000-8000-000000000022' as FolderId
const noteA = '019c0000-0000-7000-8000-000000000031' as NoteId
const noteB = '019c0000-0000-7000-8000-000000000032' as NoteId
const folderRows: Folder[] = [
  { id: folderA, parentId: null, name: '项目 A', sortOrder: 0 },
  { id: folderB, parentId: null, name: '项目 B', sortOrder: 1 },
]

function summary(id: NoteId, title: string, folderId: FolderId | null = null): NoteSummary {
  return {
    ...note(''),
    id,
    title,
    folderId,
    excerpt: `${title} 摘要`,
    updatedAt: '2026-07-31T08:00:00Z',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
    configurable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('LibraryLayout', () => {
  it('resizes columns by dragging an unlabeled visual divider and resets on double click', () => {
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => undefined)
    vi.spyOn(HTMLElement.prototype, 'releasePointerCapture').mockImplementation(() => undefined)
    render(
      <LibraryLayout
        notes={fakeNotePort()}
        folders={fakeFolderPort()}
        system={fakeSystemPort()}
      />,
    )
    const divider = screen.getByRole('separator', { name: '调整文件夹栏宽度' })
    fireEvent.pointerDown(divider, { clientX: 220, pointerId: 1 })
    fireEvent.pointerMove(divider, { clientX: 300, pointerId: 1 })
    fireEvent.pointerUp(divider, { pointerId: 1 })
    expect(screen.getByTestId('folder-pane')).toHaveStyle({ width: '300px' })
    fireEvent.doubleClick(divider)
    expect(screen.getByTestId('folder-pane')).toHaveStyle({ width: '240px' })
  })

  it('persists proportions after completed resizing and ignores preference-save failure', async () => {
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => undefined)
    vi.spyOn(HTMLElement.prototype, 'releasePointerCapture').mockImplementation(() => undefined)
    const system = fakeSystemPort({
      setWindowPreference: vi.fn().mockRejectedValue(new Error('settings unavailable')),
    })
    render(<LibraryLayout notes={fakeNotePort()} folders={fakeFolderPort()} system={system} />)
    const divider = screen.getByRole('separator', { name: '调整文件夹栏宽度' })

    fireEvent.pointerDown(divider, { clientX: 240, pointerId: 1 })
    fireEvent.pointerMove(divider, { clientX: 280, pointerId: 1 })
    expect(system.setWindowPreference).not.toHaveBeenCalled()
    fireEvent.pointerUp(divider, { pointerId: 1 })

    await waitFor(() =>
      expect(system.setWindowPreference).toHaveBeenCalledWith(
        'library-columns',
        expect.objectContaining({ folder: expect.any(Number), noteList: expect.any(Number) }),
      ),
    )
    expect(screen.getByTestId('folder-pane')).toHaveStyle({ width: '280px' })
  })

  it('loads root notes, selects a folder, clears the old document, and opens a note', async () => {
    const rootNote = summary(noteA, '根目录笔记')
    const folderNote = summary(noteB, '项目笔记', folderA)
    const document = { ...note('项目正文'), id: noteB, title: '项目笔记', folderId: folderA }
    const notes = fakeNotePort({
      listNotes: vi.fn(async (folderId) => (folderId === null ? [rootNote] : [folderNote])),
      loadNote: vi.fn().mockResolvedValue(document),
    })
    render(
      <LibraryLayout
        notes={notes}
        folders={fakeFolderPort({ listFolders: vi.fn().mockResolvedValue(folderRows) })}
        system={fakeSystemPort()}
      />,
    )

    expect(await screen.findByRole('button', { name: /根目录笔记/ })).toBeVisible()
    await userEvent.click(screen.getByRole('treeitem', { name: '项目 A' }))
    expect(await screen.findByRole('button', { name: /项目笔记/ })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: /项目笔记/ }))
    expect(await screen.findByRole('heading', { name: '项目笔记' })).toBeVisible()
    expect(notes.listNotes).toHaveBeenLastCalledWith(folderA)
    expect(notes.loadNote).toHaveBeenCalledWith(noteB)
  })

  it('does not let an earlier folder response overwrite the latest selection', async () => {
    const first = deferred<NoteSummary[]>()
    const second = deferred<NoteSummary[]>()
    const notes = fakeNotePort({
      listNotes: vi.fn((folderId) => {
        if (folderId === folderA) return first.promise
        if (folderId === folderB) return second.promise
        return Promise.resolve([])
      }),
    })
    render(
      <LibraryLayout
        notes={notes}
        folders={fakeFolderPort({ listFolders: vi.fn().mockResolvedValue(folderRows) })}
        system={fakeSystemPort()}
      />,
    )
    const firstFolder = await screen.findByRole('treeitem', { name: '项目 A' })
    await userEvent.click(firstFolder)
    await userEvent.click(screen.getByRole('treeitem', { name: '项目 B' }))
    second.resolve([summary(noteB, '最新项目', folderB)])
    expect(await screen.findByRole('button', { name: /最新项目/ })).toBeVisible()
    first.resolve([summary(noteA, '过期项目', folderA)])
    await waitFor(() => expect(screen.queryByText(/过期项目/)).not.toBeInTheDocument())
  })

  it('does not let an earlier note response replace the latest document', async () => {
    const first = deferred<NoteDocument>()
    const second = deferred<NoteDocument>()
    const notes = fakeNotePort({
      listNotes: vi.fn().mockResolvedValue([summary(noteA, '第一篇'), summary(noteB, '第二篇')]),
      loadNote: vi.fn((id) => (id === noteA ? first.promise : second.promise)),
    })
    render(<LibraryLayout notes={notes} folders={fakeFolderPort()} system={fakeSystemPort()} />)
    await userEvent.click(await screen.findByRole('button', { name: /第一篇/ }))
    await userEvent.click(screen.getByRole('button', { name: /第二篇/ }))
    second.resolve({ ...note('second'), id: noteB, title: '第二篇', folderId: null })
    expect(await screen.findByRole('heading', { name: '第二篇' })).toBeVisible()
    first.resolve({ ...note('first'), id: noteA, title: '第一篇', folderId: null })
    await waitFor(() => expect(screen.queryByRole('heading', { name: '第一篇' })).not.toBeInTheDocument())
  })

  it('distinguishes loading, empty, and safe errors without exposing diagnostics', async () => {
    const pending = deferred<NoteSummary[]>()
    const notes = fakeNotePort({ listNotes: vi.fn().mockReturnValueOnce(pending.promise) })
    const { unmount } = render(
      <LibraryLayout notes={notes} folders={fakeFolderPort()} system={fakeSystemPort()} />,
    )
    expect(screen.getByText('正在加载笔记…')).toBeVisible()
    pending.resolve([])
    expect(await screen.findByText('此文件夹中还没有笔记。')).toBeVisible()
    unmount()

    render(
      <LibraryLayout
        notes={fakeNotePort({
          listNotes: vi.fn().mockRejectedValue({
            ...commandError('io'),
            diagnostic: 'C:\\Users\\person\\private\\note.md',
          }),
        })}
        folders={fakeFolderPort()}
        system={fakeSystemPort()}
      />,
    )
    expect(await screen.findByText('无法加载笔记。')).toBeVisible()
    expect(screen.queryByText(/C:\\Users/)).not.toBeInTheDocument()
  })

  it('creates, renames, moves, and deletes folders through the folder port', async () => {
    const user = userEvent.setup()
    const folders = fakeFolderPort({
      listFolders: vi.fn().mockResolvedValue(folderRows),
      createFolder: vi.fn().mockResolvedValue({
        id: '019c0000-0000-7000-8000-000000000023' as FolderId,
        parentId: null,
        name: '新文件夹',
        sortOrder: 2,
      }),
      renameFolder: vi.fn().mockResolvedValue({ ...folderRows[0], name: '已重命名' }),
      moveFolder: vi.fn().mockResolvedValue({ ...folderRows[0], parentId: folderB }),
      deleteEmptyFolder: vi.fn().mockResolvedValue(undefined),
    })
    render(<LibraryLayout notes={fakeNotePort()} folders={folders} system={fakeSystemPort()} />)
    await screen.findByRole('treeitem', { name: '项目 A' })

    await user.click(screen.getByRole('button', { name: '新建文件夹' }))
    await user.type(screen.getByRole('textbox', { name: '文件夹名称' }), '新文件夹')
    await user.keyboard('{Enter}')
    expect(folders.createFolder).toHaveBeenCalledWith({ parentId: null, name: '新文件夹' })

    await user.click(screen.getByRole('treeitem', { name: '项目 A' }))
    await user.click(screen.getByRole('button', { name: '重命名文件夹' }))
    const rename = screen.getByRole('textbox', { name: '重命名文件夹' })
    await user.clear(rename)
    await user.type(rename, '已重命名{Enter}')
    expect(folders.renameFolder).toHaveBeenCalledWith(folderA, '已重命名')

    const source = screen.getByRole('treeitem', { name: '已重命名' })
    const target = screen.getByRole('treeitem', { name: '项目 B' })
    fireEvent.dragStart(source, { dataTransfer: { setData: vi.fn() } })
    fireEvent.drop(target, { dataTransfer: { getData: () => folderA } })
    await waitFor(() => expect(folders.moveFolder).toHaveBeenCalledWith(folderA, folderB))

    await user.click(source)
    await user.click(screen.getByRole('button', { name: '删除空文件夹' }))
    expect(folders.deleteEmptyFolder).toHaveBeenCalledWith(folderA)
  })
})
