import '@testing-library/jest-dom/vitest'
import { EditorView } from '@codemirror/view'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Folder, FolderId, NoteDocument, NoteId, NoteSummary } from '../../domain/model'
import type { SystemPort, TrashPort, WindowPreferenceMap } from '../../domain/ports'
import { commandError } from '../../domain/errors'
import { fakeFolderPort, fakeLinkPort, fakeNotePort, fakeSystemPort, fakeTemporaryPort, note, twoCaptures } from '../../test/fakes'
import { LibraryLayout } from './LibraryLayout'
import { createRef } from 'react'
import type { LibraryLayoutHandle } from './LibraryLayout'

const folderA = '019c0000-0000-7000-8000-000000000021' as FolderId
const folderB = '019c0000-0000-7000-8000-000000000022' as FolderId
const recoveredFolder = '019c0000-0000-7000-8000-000000000024' as FolderId
const noteA = '019c0000-0000-7000-8000-000000000031' as NoteId
const noteB = '019c0000-0000-7000-8000-000000000032' as NoteId
const noteC = '019c0000-0000-7000-8000-000000000033' as NoteId
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
  it('creates a note in the active folder and opens the authoritative document', async () => {
    const created = { ...note(''), id: noteC, title: '发布检查', folderId: folderA }
    const notes = fakeNotePort({
      createNote: vi.fn().mockResolvedValue(created),
      listNotes: vi.fn().mockResolvedValue([]),
    })
    const user = userEvent.setup()
    const layoutRef = createRef<LibraryLayoutHandle>()
    render(<>
      <button type="button" onClick={() => layoutRef.current?.createNote()}>新建笔记</button>
      <LibraryLayout ref={layoutRef} notes={notes} folders={fakeFolderPort({ listFolders: vi.fn().mockResolvedValue(folderRows) })} system={fakeSystemPort()} />
    </>)

    await user.click(await screen.findByRole('treeitem', { name: '项目 A' }))
    await user.click(screen.getByRole('button', { name: '新建笔记' }))
    const createDialog = screen.getByRole('dialog', { name: '新建笔记' })
    expect(within(createDialog).getByRole('combobox', { name: '保存到目录' })).toHaveValue(folderA)
    await user.type(within(createDialog).getByRole('textbox', { name: '笔记标题' }), '发布检查{Enter}')

    expect(notes.createNote).toHaveBeenCalledWith({ folderId: folderA, title: '发布检查' })
    expect(await screen.findByRole('heading', { name: '发布检查' })).toBeVisible()
    expect(screen.queryByRole('dialog', { name: '新建笔记' })).not.toBeInTheDocument()
  })

  it('linearizes new-note creation behind the active editor flush barrier', async () => {
    const pendingSave = deferred<NoteDocument>()
    const created = { ...note(''), id: noteC, title: 'Draft title' }
    const notes = fakeNotePort({
      createNote: vi.fn().mockResolvedValue(created),
      listNotes: vi.fn().mockResolvedValue([summary(noteA, 'Note A')]),
      loadNote: vi.fn().mockResolvedValue({ ...note('old body'), id: noteA, title: 'Note A' }),
      saveNote: vi.fn(() => pendingSave.promise),
    })
    const user = userEvent.setup()
    const layoutRef = createRef<LibraryLayoutHandle>()
    render(<>
      <button type="button" onClick={() => layoutRef.current?.createNote()}>新建笔记</button>
      <LibraryLayout ref={layoutRef} notes={notes} folders={fakeFolderPort()} system={fakeSystemPort()} />
    </>)
    await user.click(await screen.findByRole('button', { name: /^Note A/ }))
    const editor = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Markdown source' }))
    if (editor === null) throw new Error('CodeMirror view not found')
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'pending draft' } }))

    await user.click(screen.getByRole('button', { name: '新建笔记' }))
    await user.type(within(screen.getByRole('dialog', { name: '新建笔记' })).getByRole('textbox', { name: '笔记标题' }), 'Draft title{Enter}')

    await waitFor(() => expect(notes.saveNote).toHaveBeenCalledOnce())
    expect(notes.createNote).not.toHaveBeenCalled()
    expect(editor.state.facet(EditorView.editable)).toBe(false)
    act(() => editor.dispatch({ changes: { from: editor.state.doc.length, insert: ' must not race' } }))
    expect(editor.state.doc.toString()).toBe('pending draft')

    await act(async () => pendingSave.resolve({ ...note('pending draft'), id: noteA, title: 'Note A', revision: 2 }))
    await waitFor(() => expect(notes.createNote).toHaveBeenCalledOnce())
    expect(await screen.findByRole('heading', { name: 'Draft title' })).toBeVisible()
    expect(screen.queryByRole('dialog', { name: '新建笔记' })).not.toBeInTheDocument()
  })

  it('renames and moves a formal note through the authoritative production port', async () => {
    let current = { ...note('body'), id: noteA, title: 'Note A', folderId: folderA }
    const listNotes = vi.fn(async (folderId: FolderId | null) =>
      folderId === null || folderId === current.folderId ? [summary(current.id, current.title, current.folderId)] : [],
    )
    const notes = fakeNotePort({
      listNotes,
      loadNote: vi.fn(async () => current),
      renameNote: vi.fn(async (_id, title) => {
        current = { ...current, title, revision: current.revision + 1, updatedAt: '2026-08-11T10:00:00Z' }
        return { document: current, linkRepair: { updated: 2, failedSourceIds: [], failure: null } }
      }),
      moveNote: vi.fn(async (_id, folderId) => {
        current = { ...current, folderId, revision: current.revision + 1, updatedAt: '2026-08-11T10:01:00Z' }
        return current
      }),
    })
    const user = userEvent.setup()
    render(<LibraryLayout notes={notes} folders={fakeFolderPort({ listFolders: vi.fn().mockResolvedValue(folderRows) })} system={fakeSystemPort()} />)

    await user.click(await screen.findByRole('button', { name: /^Note A/ }))
    const title = screen.getByRole('textbox', { name: '笔记标题' })
    await user.clear(title)
    await user.type(title, 'Renamed note{Enter}')

    expect(notes.renameNote).toHaveBeenCalledWith(noteA, 'Renamed note')
    expect(await screen.findByRole('heading', { name: 'Renamed note' })).toBeVisible()
    await user.selectOptions(screen.getByRole('combobox', { name: '笔记文件夹' }), folderB)
    expect(notes.moveNote).toHaveBeenCalledWith(noteA, folderB)
    expect(await screen.findByText('笔记已移动。', { selector: '[role="status"]' })).toBeVisible()
  })

  it('adopts a committed rename revision, retries partial link repair, and saves without conflict', async () => {
    let current = { ...note('body'), id: noteA, title: 'Old title', revision: 1 }
    const renameNote = vi.fn(async (_id: NoteId, title: string) => {
      current = { ...current, title, revision: 2 }
      return renameNote.mock.calls.length === 1
        ? {
            document: current,
            linkRepair: {
              updated: 0,
              failedSourceIds: [],
              failure: { code: 'io' as const, message: 'The operation could not be completed on local storage.' },
            },
          }
        : { document: current, linkRepair: { updated: 1, failedSourceIds: [], failure: null } }
    })
    const saveNote = vi.fn(async (document: NoteDocument) => {
      if (document.revision !== 2) throw new Error('revision conflict')
      current = { ...document, revision: 3 }
      return current
    })
    const notes = fakeNotePort({
      listNotes: vi.fn(async () => [summary(noteA, current.title)]),
      loadNote: vi.fn(async () => current),
      renameNote,
      saveNote,
    })
    const ref = createRef<LibraryLayoutHandle>()
    const user = userEvent.setup()
    render(<LibraryLayout ref={ref} notes={notes} folders={fakeFolderPort()} system={fakeSystemPort()} />)
    await user.click(await screen.findByRole('button', { name: /^Old title/ }))
    const title = screen.getByRole('textbox', { name: '笔记标题' })
    await user.clear(title)
    await user.type(title, 'New title{Enter}')

    expect(await screen.findByRole('heading', { name: 'New title' })).toBeVisible()
    expect(screen.getByRole('button', { name: '重试链接修复' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: '重试链接修复' }))
    await waitFor(() => expect(renameNote).toHaveBeenCalledTimes(2))
    expect(renameNote).toHaveBeenLastCalledWith(noteA, 'New title')
    await waitFor(() => expect(screen.queryByRole('button', { name: '重试链接修复' })).not.toBeInTheDocument())

    const editor = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Markdown source' }))
    if (editor === null) throw new Error('CodeMirror view not found')
    act(() => editor.dispatch({ changes: { from: editor.state.doc.length, insert: ' edited' } }))
    const release = await ref.current?.prepareExit()
    expect(release).toEqual(expect.any(Function))
    expect(saveNote).toHaveBeenCalledWith(expect.objectContaining({
      title: 'New title', revision: 2, markdown: 'body edited',
    }))
    release?.()
  })

  it('restores a manual collapse as a functional rail and persists only explicit expansion', async () => {
    const getWindowPreference = vi.fn(async (key: keyof WindowPreferenceMap) => ({
      'library-columns': { folder: 0.25, noteList: 0.3 },
      'library-collapsed': { folder: true, noteList: false },
    })[key]) as unknown as SystemPort['getWindowPreference']
    const system = fakeSystemPort({
      getWindowPreference,
    })
    const user = userEvent.setup()
    render(<LibraryLayout notes={fakeNotePort()} folders={fakeFolderPort()} system={system} />)
    expect(await screen.findByRole('button', { name: '展开资料库' })).toBeVisible()
    expect(screen.getByTestId('folder-pane')).toHaveStyle({ width: '0px' })
    await user.click(screen.getByRole('button', { name: '展开资料库' }))
    expect(system.setWindowPreference).toHaveBeenCalledWith('library-collapsed', { folder: false, noteList: false })
    expect(screen.getByTestId('folder-pane')).not.toHaveStyle({ width: '0px' })
    expect(screen.getByRole('button', { name: '折叠资料库' })).toBeVisible()
  })

  it('uses the folder rail entry to visibly expand the library from the unfiled destination', async () => {
    const getWindowPreference = vi.fn(async (key: keyof WindowPreferenceMap) => ({
      'library-columns': undefined,
      'library-collapsed': { folder: true, noteList: false },
    })[key]) as unknown as SystemPort['getWindowPreference']
    const system = fakeSystemPort({ getWindowPreference })
    const user = userEvent.setup()
    render(<LibraryLayout notes={fakeNotePort()} folders={fakeFolderPort()} system={system} />)

    await user.click(await screen.findByRole('button', { name: '文件夹' }))
    expect(screen.queryByRole('navigation', { name: '折叠的资料库' })).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: '文件夹' })).toBeVisible()
    expect(system.setWindowPreference).toHaveBeenCalledWith('library-collapsed', { folder: false, noteList: false })
  })

  it('keeps the current unfiled note selected when its active rail entry is clicked again', async () => {
    const selected = { ...note('selected body'), id: noteA, title: 'Selected note' }
    const notes = fakeNotePort({
      listNotes: vi.fn().mockResolvedValue([summary(noteA, selected.title)]),
      loadNote: vi.fn().mockResolvedValue(selected),
    })
    const getWindowPreference = vi.fn(async (key: keyof WindowPreferenceMap) => ({
      'library-columns': undefined,
      'library-collapsed': { folder: true, noteList: false },
    })[key]) as unknown as SystemPort['getWindowPreference']
    const user = userEvent.setup()
    render(<LibraryLayout notes={notes} folders={fakeFolderPort()} system={fakeSystemPort({ getWindowPreference })} />)

    await user.click(await screen.findByRole('button', { name: /^Selected note/ }))
    expect(await screen.findByRole('heading', { name: 'Selected note' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: '未归档笔记' }))

    expect(screen.getByRole('heading', { name: 'Selected note' })).toBeVisible()
    expect(notes.loadNote).toHaveBeenCalledTimes(1)
  })

  it('automatically collapses at the planned threshold without overwriting manual preferences', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 700,
      height: 700,
      left: 0,
      right: 820,
      top: 0,
      width: 820,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const system = fakeSystemPort()
    render(<LibraryLayout notes={fakeNotePort()} folders={fakeFolderPort()} system={system} />)

    expect(await screen.findByRole('navigation', { name: '折叠的资料库' })).toBeVisible()
    expect(screen.getByRole('button', { name: '展开目录，0 篇笔记' })).toHaveTextContent('目录 · 0')
    expect(screen.getByTestId('folder-pane')).toHaveAttribute('inert')
    expect(screen.getByTestId('note-list-pane')).toHaveAttribute('inert')
    expect(system.setWindowPreference).not.toHaveBeenCalledWith('library-collapsed', expect.anything())
  })

  it('records an explicit rail expansion as a cleared manual preference while responsive collapse remains effective', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 700,
      height: 700,
      left: 0,
      right: 1000,
      top: 0,
      width: 1000,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const system = fakeSystemPort()
    const user = userEvent.setup()
    render(<LibraryLayout notes={fakeNotePort()} folders={fakeFolderPort()} system={system} />)

    await user.click(await screen.findByRole('button', { name: '展开资料库' }))
    expect(system.setWindowPreference).toHaveBeenCalledWith('library-collapsed', { folder: false, noteList: false })
    expect(screen.getByRole('navigation', { name: '折叠的资料库' })).toBeVisible()
    expect(screen.getByTestId('folder-pane')).toHaveAttribute('inert')
  })

  it('manually collapses and restores the note directory independently from the library', async () => {
    const system = fakeSystemPort()
    const user = userEvent.setup()
    render(<LibraryLayout notes={fakeNotePort()} folders={fakeFolderPort()} system={system} />)

    await user.click(await screen.findByRole('button', { name: '折叠目录' }))
    expect(screen.getByRole('button', { name: '展开目录，0 篇笔记' })).toHaveTextContent('目录 · 0')
    expect(screen.getByTestId('folder-pane')).not.toHaveAttribute('inert')
    expect(screen.getByTestId('note-list-pane')).toHaveAttribute('inert')
    expect(system.setWindowPreference).toHaveBeenCalledWith('library-collapsed', { folder: false, noteList: true })

    await user.click(screen.getByRole('button', { name: '展开目录，0 篇笔记' }))
    expect(screen.getByTestId('note-list-pane')).not.toHaveAttribute('inert')
    expect(system.setWindowPreference).toHaveBeenLastCalledWith('library-collapsed', { folder: false, noteList: false })
  })
  it('holds the active editor behind a barrier while flushing for a storage move', async () => {
    const saveNote = vi.fn(async (document: NoteDocument) => ({ ...document, revision: document.revision + 1 }))
    const notes = fakeNotePort({
      listNotes: vi.fn().mockResolvedValue([summary(noteA, 'Note A')]),
      loadNote: vi.fn().mockResolvedValue({ ...note('old'), id: noteA, title: 'Note A' }),
      saveNote,
    })
    const ref = createRef<LibraryLayoutHandle>()
    const user = userEvent.setup()
    render(<LibraryLayout ref={ref} notes={notes} folders={fakeFolderPort()} system={fakeSystemPort()} />)
    await user.click(await screen.findByRole('button', { name: /^Note A/ }))
    const editor = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Markdown source' }))
    if (editor === null) throw new Error('CodeMirror view not found')
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'pending move' } }))

    const release = await ref.current?.prepareStorageMove()
    expect(saveNote).toHaveBeenCalledOnce()
    expect(release).toEqual(expect.any(Function))
    expect(editor.state.facet(EditorView.editable)).toBe(false)
    release?.()
    expect(editor.state.facet(EditorView.editable)).toBe(true)
  })
  it('flushes the active editor before deleting a formal note and exposes immediate undo', async () => {
    const pendingSave = deferred<NoteDocument>()
    const listNotes = vi.fn()
      .mockResolvedValueOnce([summary(noteA, 'Note A')])
      .mockResolvedValueOnce([])
      .mockResolvedValue([summary(noteA, 'Note A')])
    const folderList = vi.fn().mockResolvedValue(folderRows)
    const notes = fakeNotePort({
      listNotes,
      loadNote: vi.fn().mockResolvedValue({ ...note('old body'), id: noteA, title: 'Note A' }),
      saveNote: vi.fn(() => pendingSave.promise),
    })
    const trash: TrashPort = {
      trash: vi.fn().mockResolvedValue({ operationId: 'delete-op', trashed: [noteA], failed: [] }),
      list: vi.fn().mockResolvedValue([]),
      restore: vi.fn().mockResolvedValue({ restored: [], failed: [] }),
      undo: vi.fn().mockResolvedValue({ restored: [{ ...note('saved body'), id: noteA, title: 'Note A' }], failed: [] }),
      purgeExpired: vi.fn().mockResolvedValue({ purged: [], failed: [] }),
    }
    const user = userEvent.setup()
    render(<LibraryLayout notes={notes} folders={fakeFolderPort({ listFolders: folderList })} system={fakeSystemPort()} trash={trash} />)

    await user.click(await screen.findByRole('button', { name: /^Note A/ }))
    const editor = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Markdown source' }))
    if (editor === null) throw new Error('CodeMirror view not found')
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'saved body' } }))
    screen.getByRole('button', { name: '删除 Note A' }).click()

    await waitFor(() => expect(notes.saveNote).toHaveBeenCalledOnce())
    expect(trash.trash).not.toHaveBeenCalled()
    await act(async () => pendingSave.resolve({ ...note('saved body'), id: noteA, title: 'Note A', revision: 2 }))
    await waitFor(() => expect(trash.trash).toHaveBeenCalledWith([noteA]))
    const deletionFeedback = await screen.findByText('“Note A”已移入回收站。')
    expect(deletionFeedback).toBeVisible()
    await waitFor(() => expect(deletionFeedback).toHaveFocus())

    await user.click(screen.getByRole('button', { name: '撤销删除' }))
    expect(trash.undo).toHaveBeenCalledWith('delete-op')
    await waitFor(() => expect(listNotes.mock.calls.length).toBeGreaterThanOrEqual(3))
    expect(folderList.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(await screen.findByRole('button', { name: /^Note A/ })).toBeVisible()
  })

  it('keeps a formal note when its editor flush or trash operation fails', async () => {
    const trashNote = vi.fn()
    const notes = fakeNotePort({
      listNotes: vi.fn().mockResolvedValue([summary(noteA, 'Note A')]),
      loadNote: vi.fn().mockResolvedValue({ ...note('old body'), id: noteA, title: 'Note A' }),
      saveNote: vi.fn().mockRejectedValue(commandError('io')),
    })
    const trash: TrashPort = {
      trash: trashNote,
      list: vi.fn().mockResolvedValue([]),
      restore: vi.fn().mockResolvedValue({ restored: [], failed: [] }),
      undo: vi.fn().mockResolvedValue({ restored: [], failed: [] }),
      purgeExpired: vi.fn().mockResolvedValue({ purged: [], failed: [] }),
    }
    const user = userEvent.setup()
    render(<LibraryLayout notes={notes} folders={fakeFolderPort()} system={fakeSystemPort()} trash={trash} />)

    await user.click(await screen.findByRole('button', { name: /^Note A/ }))
    const editor = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Markdown source' }))
    if (editor === null) throw new Error('CodeMirror view not found')
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'unsaved body' } }))
    await user.click(screen.getByRole('button', { name: '删除 Note A' }))

    expect(await screen.findByText('请先解决保存错误，再删除笔记。')).toBeVisible()
    expect(trashNote).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Note A' })).toBeVisible()
  })

  it('shows a per-item trash failure and leaves the formal note reachable', async () => {
    const trash: TrashPort = {
      trash: vi.fn().mockResolvedValue({ operationId: 'unused', trashed: [], failed: [{ noteId: noteA, message: '文件正在被使用' }] }),
      list: vi.fn().mockResolvedValue([]),
      restore: vi.fn().mockResolvedValue({ restored: [], failed: [] }),
      undo: vi.fn().mockResolvedValue({ restored: [], failed: [] }),
      purgeExpired: vi.fn().mockResolvedValue({ purged: [], failed: [] }),
    }
    const user = userEvent.setup()
    render(
      <LibraryLayout
        notes={fakeNotePort({ listNotes: vi.fn().mockResolvedValue([summary(noteA, 'Note A')]) })}
        folders={fakeFolderPort()}
        system={fakeSystemPort()}
        trash={trash}
      />,
    )

    await user.click(await screen.findByRole('button', { name: '删除 Note A' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('文件正在被使用')
    expect(screen.getByRole('button', { name: /^Note A/ })).toBeVisible()
    expect(screen.queryByRole('button', { name: '撤销删除' })).not.toBeInTheDocument()
  })

  it('locks the current editor while trash is pending and unlocks it after failure', async () => {
    const pendingTrash = deferred<Awaited<ReturnType<TrashPort['trash']>>>()
    const documents = new Map<NoteId, NoteDocument>([
      [noteA, { ...note('A body'), id: noteA, title: 'Note A' }],
      [noteB, { ...note('B body'), id: noteB, title: 'Note B' }],
    ])
    const notes = fakeNotePort({
      listNotes: vi.fn().mockResolvedValue([summary(noteA, 'Note A'), summary(noteB, 'Note B')]),
      loadNote: vi.fn(async (id) => documents.get(id)!),
      saveNote: vi.fn(async (document) => ({ ...document, revision: document.revision + 1 })),
    })
    const trash: TrashPort = {
      trash: vi.fn(() => pendingTrash.promise),
      list: vi.fn().mockResolvedValue([]),
      restore: vi.fn().mockResolvedValue({ restored: [], failed: [] }),
      undo: vi.fn().mockResolvedValue({ restored: [], failed: [] }),
      purgeExpired: vi.fn().mockResolvedValue({ purged: [], failed: [] }),
    }
    const user = userEvent.setup()
    render(<LibraryLayout notes={notes} folders={fakeFolderPort()} system={fakeSystemPort()} trash={trash} />)

    await user.click(await screen.findByRole('button', { name: /^Note A/ }))
    const textbox = await screen.findByRole('textbox', { name: 'Markdown source' })
    const editor = EditorView.findFromDOM(textbox)
    if (editor === null) throw new Error('CodeMirror view not found')
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'durable before delete' } }))
    await user.click(screen.getByRole('button', { name: '删除 Note A' }))
    await waitFor(() => expect(trash.trash).toHaveBeenCalledWith([noteA]))

    expect(textbox).toHaveAttribute('contenteditable', 'false')
    act(() => editor.dispatch({ changes: { from: editor.state.doc.length, insert: ' late edit' } }))
    expect(editor.state.doc.toString()).toBe('durable before delete')
    await user.click(screen.getByRole('button', { name: /^Note B/ }))
    expect(screen.getByRole('heading', { name: 'Note A' })).toBeVisible()

    await act(async () => pendingTrash.resolve({
      operationId: 'unused',
      trashed: [],
      failed: [{ noteId: noteA, message: '文件正在被使用' }],
    }))
    await waitFor(() => expect(textbox).toHaveAttribute('contenteditable', 'true'))
    act(() => editor.dispatch({ changes: { from: editor.state.doc.length, insert: ' editable again' } }))
    expect(editor.state.doc.toString()).toBe('durable before delete editable again')
  })

  it('holds the shared editor barrier while deleting a different listed note', async () => {
    const pendingTrash = deferred<Awaited<ReturnType<TrashPort['trash']>>>()
    const documents = new Map<NoteId, NoteDocument>([
      [noteA, { ...note('A body'), id: noteA, title: 'Note A' }],
      [noteB, { ...note('B body'), id: noteB, title: 'Note B' }],
    ])
    const notes = fakeNotePort({
      listNotes: vi.fn().mockResolvedValue([summary(noteA, 'Note A'), summary(noteB, 'Note B')]),
      loadNote: vi.fn(async (id) => documents.get(id)!),
    })
    const trash: TrashPort = {
      trash: vi.fn(() => pendingTrash.promise),
      list: vi.fn().mockResolvedValue([]),
      restore: vi.fn().mockResolvedValue({ restored: [], failed: [] }),
      undo: vi.fn().mockResolvedValue({ restored: [], failed: [] }),
      purgeExpired: vi.fn().mockResolvedValue({ purged: [], failed: [] }),
    }
    const user = userEvent.setup()
    render(<LibraryLayout notes={notes} folders={fakeFolderPort()} system={fakeSystemPort()} trash={trash} />)

    await user.click(await screen.findByRole('button', { name: /^Note A/ }))
    const textbox = await screen.findByRole('textbox', { name: 'Markdown source' })
    await user.click(screen.getByRole('button', { name: '删除 Note B' }))
    await waitFor(() => expect(trash.trash).toHaveBeenCalledWith([noteB]))

    expect(textbox).toHaveAttribute('contenteditable', 'false')
    await act(async () => pendingTrash.resolve({ operationId: 'delete-op', trashed: [noteB], failed: [] }))
    await waitFor(() => expect(textbox).toHaveAttribute('contenteditable', 'true'))
  })

  it('keeps the deletion barrier through success and never schedules a late save', async () => {
    const pendingTrash = deferred<Awaited<ReturnType<TrashPort['trash']>>>()
    const saveNote = vi.fn(async (document: NoteDocument) => ({ ...document, revision: document.revision + 1 }))
    const notes = fakeNotePort({
      listNotes: vi.fn().mockResolvedValueOnce([summary(noteA, 'Note A')]).mockResolvedValue([]),
      loadNote: vi.fn().mockResolvedValue({ ...note('A body'), id: noteA, title: 'Note A' }),
      saveNote,
    })
    const trash: TrashPort = {
      trash: vi.fn(() => pendingTrash.promise),
      list: vi.fn().mockResolvedValue([]),
      restore: vi.fn().mockResolvedValue({ restored: [], failed: [] }),
      undo: vi.fn().mockResolvedValue({ restored: [], failed: [] }),
      purgeExpired: vi.fn().mockResolvedValue({ purged: [], failed: [] }),
    }
    const user = userEvent.setup()
    render(<LibraryLayout notes={notes} folders={fakeFolderPort()} system={fakeSystemPort()} trash={trash} />)

    await user.click(await screen.findByRole('button', { name: /^Note A/ }))
    const textbox = await screen.findByRole('textbox', { name: 'Markdown source' })
    const editor = EditorView.findFromDOM(textbox)
    if (editor === null) throw new Error('CodeMirror view not found')
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'durable before delete' } }))
    await user.click(screen.getByRole('button', { name: '删除 Note A' }))
    await waitFor(() => expect(trash.trash).toHaveBeenCalledWith([noteA]))
    act(() => editor.dispatch({ changes: { from: editor.state.doc.length, insert: ' late edit' } }))

    expect(editor.state.doc.toString()).toBe('durable before delete')
    await act(async () => pendingTrash.resolve({ operationId: 'delete-op', trashed: [noteA], failed: [] }))
    expect(await screen.findByText('“Note A”已移入回收站。')).toBeVisible()
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(saveNote).toHaveBeenCalledOnce()
  })

  it('opens the application trash from folder navigation', async () => {
    const trash: TrashPort = {
      trash: vi.fn().mockResolvedValue({ operationId: 'op', trashed: [], failed: [] }),
      list: vi.fn().mockResolvedValue([]),
      restore: vi.fn().mockResolvedValue({ restored: [], failed: [] }),
      undo: vi.fn().mockResolvedValue({ restored: [], failed: [] }),
      purgeExpired: vi.fn().mockResolvedValue({ purged: [], failed: [] }),
    }
    const user = userEvent.setup()
    render(
      <LibraryLayout
        notes={fakeNotePort()}
        folders={fakeFolderPort({ listFolders: vi.fn().mockResolvedValue(folderRows) })}
        system={fakeSystemPort()}
        trash={trash}
      />,
    )

    await user.click(await screen.findByRole('treeitem', { name: '回收站' }))
    expect(await screen.findByRole('region', { name: '回收站' })).toBeVisible()
  })

  it('shows a recovered folder and its restored note after restoring from trash', async () => {
    const folderList = vi.fn()
      .mockResolvedValueOnce(folderRows)
      .mockResolvedValue([...folderRows, { id: recoveredFolder, parentId: null, name: '已恢复', sortOrder: 2 }])
    const listNotes = vi.fn(async (folderId: FolderId | null) => folderId === recoveredFolder
      ? [summary(noteA, 'Recovered note', recoveredFolder)]
      : [])
    const trash: TrashPort = {
      trash: vi.fn().mockResolvedValue({ operationId: 'op', trashed: [], failed: [] }),
      list: vi.fn().mockResolvedValue([{
        noteId: noteA,
        kind: 'formal',
        title: 'Recovered note',
        previousFolderId: '019c0000-0000-7000-8000-000000000099' as FolderId,
        previousRelativePath: `notes/${noteA}`,
        deletedAt: '2026-08-02T02:30:00Z',
        assets: [],
        operationId: 'delete-op',
      }]),
      restore: vi.fn().mockResolvedValue({
        restored: [{ ...note(''), id: noteA, title: 'Recovered note', folderId: recoveredFolder }],
        failed: [],
      }),
      undo: vi.fn().mockResolvedValue({ restored: [], failed: [] }),
      purgeExpired: vi.fn().mockResolvedValue({ purged: [], failed: [] }),
    }
    const user = userEvent.setup()
    render(
      <LibraryLayout
        notes={fakeNotePort({ listNotes })}
        folders={fakeFolderPort({ listFolders: folderList })}
        system={fakeSystemPort()}
        trash={trash}
      />,
    )

    await user.click(await screen.findByRole('treeitem', { name: '回收站' }))
    await user.click(await screen.findByRole('checkbox', { name: '选择 Recovered note' }))
    await user.click(screen.getByRole('button', { name: '恢复所选' }))
    await user.click(await screen.findByRole('treeitem', { name: '已恢复' }))

    expect(await screen.findByRole('button', { name: /^Recovered note/ })).toBeVisible()
    expect(folderList.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('switches to the temporary inbox without changing the persisted column layout', async () => {
    const system = fakeSystemPort({
      getWindowPreference: vi.fn().mockResolvedValue({ folder: 0.25, noteList: 0.3 }),
    })
    const user = userEvent.setup()
    render(
      <LibraryLayout
        notes={fakeNotePort()}
        folders={fakeFolderPort({ listFolders: vi.fn().mockResolvedValue(folderRows) })}
        system={system}
        temporary={fakeTemporaryPort(twoCaptures())}
      />,
    )

    await user.click(await screen.findByRole('treeitem', { name: '临时收集箱' }))
    expect(await screen.findByRole('region', { name: '临时收集箱' })).toBeVisible()
    expect(screen.getByTestId('folder-pane')).toHaveStyle({ width: '240px' })
    expect(screen.getByTestId('note-list-pane')).toHaveStyle({ width: '300px' })
  })

  it('flushes the active temporary editor before a toolbar search result returns to the library', async () => {
    const pendingSave = deferred<NoteDocument>()
    const notes = fakeNotePort({
      listNotes: vi.fn().mockResolvedValue([summary(noteA, 'Search target')]),
      loadNote: vi.fn().mockResolvedValue({ ...note('body'), id: noteA, title: 'Search target' }),
    })
    const temporary = fakeTemporaryPort(twoCaptures())
    temporary.save = vi.fn(() => pendingSave.promise)
    const ref = createRef<LibraryLayoutHandle>()
    const user = userEvent.setup()
    render(<LibraryLayout ref={ref} notes={notes} folders={fakeFolderPort()} system={fakeSystemPort()} temporary={temporary} autosaveDelayMs={2000} />)
    await user.click(await screen.findByRole('treeitem', { name: '临时收集箱' }))
    await user.click(await screen.findByRole('button', { name: /发布前检查/ }))
    const editor = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Markdown source' }))
    if (editor === null) throw new Error('CodeMirror view not found')
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '尚未保存的临时内容' } }))
    act(() => ref.current?.selectSearchResult(noteA))

    await waitFor(() => expect(temporary.save).toHaveBeenCalledOnce())
    expect(notes.loadNote).not.toHaveBeenCalled()
    await act(async () => pendingSave.resolve({ ...twoCaptures()[0], markdown: '尚未保存的临时内容', revision: 2 }))
    expect(await screen.findByRole('heading', { name: 'Search target' })).toBeVisible()
  })

  it('restores valid saved column proportions against the measured container width', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 700,
      height: 700,
      left: 0,
      right: 1200,
      top: 0,
      width: 1200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const system = fakeSystemPort({
      getWindowPreference: vi.fn().mockResolvedValue({ folder: 0.25, noteList: 0.3 }),
    })

    render(<LibraryLayout notes={fakeNotePort()} folders={fakeFolderPort()} system={system} />)

    await waitFor(() => expect(screen.getByTestId('folder-pane')).toHaveStyle({ width: '300px' }))
    expect(screen.getByTestId('note-list-pane')).toHaveStyle({ width: '360px' })
    expect(system.getWindowPreference).toHaveBeenCalledWith('library-columns')
  })

  it.each([
    ['non-object', 'bad'],
    ['out-of-range', { folder: 1.2, noteList: 0.2 }],
    ['over-full', { folder: 0.7, noteList: 0.5 }],
  ])('falls back to defaults for a malformed %s preference', async (_case, value) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 700,
      height: 700,
      left: 0,
      right: 1200,
      top: 0,
      width: 1200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const system = fakeSystemPort({ getWindowPreference: vi.fn().mockResolvedValue(value) })

    render(<LibraryLayout notes={fakeNotePort()} folders={fakeFolderPort()} system={system} />)

    await waitFor(() => expect(system.getWindowPreference).toHaveBeenCalled())
    expect(screen.getByTestId('folder-pane')).toHaveStyle({ width: '240px' })
    expect(screen.getByTestId('note-list-pane')).toHaveStyle({ width: '300px' })
  })

  it('keeps usable defaults when loading the saved preference fails', async () => {
    const system = fakeSystemPort({
      getWindowPreference: vi.fn().mockRejectedValue(new Error('store unavailable')),
    })

    render(<LibraryLayout notes={fakeNotePort()} folders={fakeFolderPort()} system={system} />)

    await waitFor(() => expect(system.getWindowPreference).toHaveBeenCalled())
    expect(screen.getByTestId('folder-pane')).toHaveStyle({ width: '240px' })
    expect(screen.getByTestId('note-list-pane')).toHaveStyle({ width: '300px' })
  })

  it('keeps a locally committed resize when an older preference read resolves late', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 700,
      height: 700,
      left: 0,
      right: 1200,
      top: 0,
      width: 1200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const preference = deferred<{ folder: number; noteList: number } | undefined>()
    const system = fakeSystemPort({
      getWindowPreference: vi.fn().mockReturnValue(preference.promise),
    })
    render(<LibraryLayout notes={fakeNotePort()} folders={fakeFolderPort()} system={system} />)
    const divider = screen.getAllByRole('separator')[0]

    fireEvent.pointerDown(divider, { clientX: 240, pointerId: 1 })
    fireEvent.pointerMove(divider, { clientX: 300, pointerId: 1 })
    fireEvent.pointerUp(divider, { pointerId: 1 })
    expect(screen.getByTestId('folder-pane')).toHaveStyle({ width: '300px' })
    expect(screen.getByTestId('note-list-pane')).toHaveStyle({ width: '300px' })

    await act(async () => {
      preference.resolve({ folder: 0.4, noteList: 0.3 })
      await preference.promise
    })

    expect(screen.getByTestId('folder-pane')).toHaveStyle({ width: '300px' })
    expect(screen.getByTestId('note-list-pane')).toHaveStyle({ width: '300px' })
  })

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

  it('mounts the selected note editor and flushes its Markdown through the note port', async () => {
    const saveNote = vi.fn(async (document: NoteDocument) => ({ ...document, revision: 2 }))
    const notes = fakeNotePort({
      listNotes: vi.fn().mockResolvedValue([summary(noteA, 'Editable')]),
      loadNote: vi.fn().mockResolvedValue({ ...note('old'), id: noteA, title: 'Editable' }),
      saveNote,
    })
    render(<LibraryLayout notes={notes} folders={fakeFolderPort()} system={fakeSystemPort()} />)
    await userEvent.click(await screen.findByRole('button', { name: /Editable/ }))
    const textbox = await screen.findByRole('textbox', { name: 'Markdown source' })
    const editor = EditorView.findFromDOM(textbox)
    if (editor === null) throw new Error('CodeMirror view not found')

    act(() => {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'edited' } })
      window.dispatchEvent(new Event('blur'))
    })

    await waitFor(() =>
      expect(saveNote).toHaveBeenCalledWith(expect.objectContaining({ id: noteA, markdown: 'edited' })),
    )
  })

  it('keeps the current dirty note visible while navigation waits for its save', async () => {
    const pendingSave = deferred<NoteDocument>()
    const loadNote = vi.fn(async (id: NoteId) =>
      id === noteA
        ? { ...note('A body'), id: noteA, title: 'Note A' }
        : { ...note('B body'), id: noteB, title: 'Note B' },
    )
    const notes = fakeNotePort({
      listNotes: vi.fn().mockResolvedValue([summary(noteA, 'Note A'), summary(noteB, 'Note B')]),
      loadNote,
      saveNote: vi.fn(() => pendingSave.promise),
    })
    const user = userEvent.setup()
    render(<LibraryLayout notes={notes} folders={fakeFolderPort()} system={fakeSystemPort()} />)
    await user.click(await screen.findByRole('button', { name: /Note A/ }))
    const textbox = await screen.findByRole('textbox', { name: 'Markdown source' })
    const editor = EditorView.findFromDOM(textbox)
    if (editor === null) throw new Error('CodeMirror view not found')
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'A draft' } }))

    await user.click(screen.getByRole('button', { name: /Note B/ }))

    expect(screen.getByRole('heading', { name: 'Note A' })).toBeVisible()
    expect(EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Markdown source' }))?.state.doc.toString()).toBe('A draft')
    expect(loadNote).not.toHaveBeenCalledWith(noteB)
    await act(async () => pendingSave.resolve({ ...note('A draft'), id: noteA, title: 'Note A', revision: 2 }))
    await screen.findByRole('heading', { name: 'Note B' })
  })

  it('keeps the current dirty note visible while folder navigation waits for its save', async () => {
    const pendingSave = deferred<NoteDocument>()
    const listNotes = vi.fn(async (folderId: FolderId | null) =>
      folderId === null ? [summary(noteA, 'Note A')] : [],
    )
    const notes = fakeNotePort({
      listNotes,
      loadNote: vi.fn().mockResolvedValue({ ...note('A body'), id: noteA, title: 'Note A' }),
      saveNote: vi.fn(() => pendingSave.promise),
    })
    const user = userEvent.setup()
    render(
      <LibraryLayout
        notes={notes}
        folders={fakeFolderPort({ listFolders: vi.fn().mockResolvedValue(folderRows) })}
        system={fakeSystemPort()}
      />,
    )
    await user.click(await screen.findByRole('button', { name: /Note A/ }))
    const editor = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Markdown source' }))
    if (editor === null) throw new Error('CodeMirror view not found')
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'A draft' } }))

    await user.click(screen.getByRole('treeitem', { name: folderRows[0].name }))

    expect(screen.getByRole('heading', { name: 'Note A' })).toBeVisible()
    expect(listNotes).not.toHaveBeenCalledWith(folderA)
    await act(async () => pendingSave.resolve({ ...note('A draft'), id: noteA, title: 'Note A', revision: 2 }))
    await waitFor(() => expect(listNotes).toHaveBeenCalledWith(folderA))
  })

  it('keeps the dirty editor and retry UI when navigation save fails', async () => {
    const loadNote = vi.fn(async (id: NoteId) =>
      id === noteA
        ? { ...note('A body'), id: noteA, title: 'Note A' }
        : { ...note('B body'), id: noteB, title: 'Note B' },
    )
    const notes = fakeNotePort({
      listNotes: vi.fn().mockResolvedValue([summary(noteA, 'Note A'), summary(noteB, 'Note B')]),
      loadNote,
      saveNote: vi.fn().mockRejectedValue(commandError('io')),
    })
    const user = userEvent.setup()
    render(<LibraryLayout notes={notes} folders={fakeFolderPort()} system={fakeSystemPort()} />)
    await user.click(await screen.findByRole('button', { name: /Note A/ }))
    const editor = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Markdown source' }))
    if (editor === null) throw new Error('CodeMirror view not found')
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'kept A' } }))

    await user.click(screen.getByRole('button', { name: /Note B/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be saved/i)
    expect(screen.getByRole('button', { name: '重试保存' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Note A' })).toBeVisible()
    expect(editor.state.doc.toString()).toBe('kept A')
    expect(loadNote).not.toHaveBeenCalledWith(noteB)
  })

  it('keeps the current editor and conflict guidance when navigation finds a revision conflict', async () => {
    const loadNote = vi.fn(async (id: NoteId) =>
      id === noteA
        ? { ...note('A body'), id: noteA, title: 'Note A' }
        : { ...note('B body'), id: noteB, title: 'Note B' },
    )
    const notes = fakeNotePort({
      listNotes: vi.fn().mockResolvedValue([summary(noteA, 'Note A'), summary(noteB, 'Note B')]),
      loadNote,
      saveNote: vi.fn().mockRejectedValue(commandError('conflict')),
    })
    const user = userEvent.setup()
    render(<LibraryLayout notes={notes} folders={fakeFolderPort()} system={fakeSystemPort()} />)
    await user.click(await screen.findByRole('button', { name: /Note A/ }))
    const editor = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Markdown source' }))
    if (editor === null) throw new Error('CodeMirror view not found')
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'conflicted A' } }))

    await user.click(screen.getByRole('button', { name: /Note B/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/changed elsewhere|reload/i)
    expect(screen.getByRole('heading', { name: 'Note A' })).toBeVisible()
    expect(editor.state.doc.toString()).toBe('conflicted A')
    expect(loadNote).not.toHaveBeenCalledWith(noteB)
  })

  it('flushes successfully before navigation and never crosses note content or IDs', async () => {
    const loadNote = vi.fn(async (id: NoteId) =>
      id === noteA
        ? { ...note('A body'), id: noteA, title: 'Note A' }
        : { ...note('B body'), id: noteB, title: 'Note B', revision: 4 },
    )
    const saveNote = vi.fn(async (document: NoteDocument) => ({
      ...document,
      revision: document.revision + 1,
    }))
    const notes = fakeNotePort({
      listNotes: vi.fn().mockResolvedValue([summary(noteA, 'Note A'), summary(noteB, 'Note B')]),
      loadNote,
      saveNote,
    })
    const user = userEvent.setup()
    render(<LibraryLayout notes={notes} folders={fakeFolderPort()} system={fakeSystemPort()} />)
    await user.click(await screen.findByRole('button', { name: /Note A/ }))
    const first = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Markdown source' }))
    if (first === null) throw new Error('CodeMirror view not found')
    act(() => first.dispatch({ changes: { from: 0, to: first.state.doc.length, insert: 'A saved' } }))

    await user.click(screen.getByRole('button', { name: /Note B/ }))

    expect(await screen.findByRole('heading', { name: 'Note B' })).toBeVisible()
    expect(saveNote.mock.calls[0][0]).toMatchObject({ id: noteA, markdown: 'A saved' })
    const second = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Markdown source' }))
    if (second === null) throw new Error('CodeMirror view not found')
    act(() => {
      second.dispatch({ changes: { from: 0, to: second.state.doc.length, insert: 'B saved' } })
      window.dispatchEvent(new Event('blur'))
    })
    await waitFor(() => expect(saveNote).toHaveBeenCalledTimes(2))
    expect(saveNote.mock.calls[1][0]).toMatchObject({ id: noteB, markdown: 'B saved' })
    expect(saveNote).not.toHaveBeenCalledWith(expect.objectContaining({ id: noteB, markdown: 'A saved' }))
  })

  it('flushes source-link navigation and applies only the latest rapid target', async () => {
    const pendingSave = deferred<NoteDocument>()
    const documents = new Map<NoteId, NoteDocument>([
      [noteA, { ...note(`[[Note B|${noteB}]] [[Note C|${noteC}]]`), id: noteA, title: 'Note A' }],
      [noteB, { ...note('B'), id: noteB, title: 'Note B' }],
      [noteC, { ...note('C'), id: noteC, title: 'Note C' }],
    ])
    const notes = fakeNotePort({
      listNotes: vi.fn().mockResolvedValue([
        summary(noteA, 'Note A'),
        summary(noteB, 'Note B'),
        summary(noteC, 'Note C'),
      ]),
      loadNote: vi.fn(async (id) => documents.get(id)!),
      saveNote: vi.fn(() => pendingSave.promise),
    })
    const user = userEvent.setup()
    render(
      <LibraryLayout
        notes={notes}
        folders={fakeFolderPort()}
        system={fakeSystemPort()}
        links={fakeLinkPort()}
      />,
    )
    await user.click(await screen.findByRole('button', { name: /Note A/ }))
    const view = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Markdown source' }))!
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: ' draft' } }))

    await user.click(await screen.findByRole('link', { name: '[[Note B]]' }))
    await user.click(screen.getByRole('link', { name: '[[Note C]]' }))
    expect(screen.getByRole('heading', { name: 'Note A' })).toBeVisible()
    expect(notes.loadNote).not.toHaveBeenCalledWith(noteB)
    expect(notes.loadNote).not.toHaveBeenCalledWith(noteC)

    await act(async () => pendingSave.resolve({ ...documents.get(noteA)!, markdown: documents.get(noteA)!.markdown + ' draft', revision: 2 }))
    expect(await screen.findByRole('heading', { name: 'Note C' })).toBeVisible()
    expect(notes.loadNote).not.toHaveBeenCalledWith(noteB)
  })

  it('uses the same stable link navigation in preview mode', async () => {
    const documents = new Map<NoteId, NoteDocument>([
      [noteA, { ...note(`[[Note B|${noteB}]]`), id: noteA, title: 'Note A' }],
      [noteB, { ...note('B'), id: noteB, title: 'Note B' }],
    ])
    const notes = fakeNotePort({
      listNotes: vi.fn().mockResolvedValue([summary(noteA, 'Note A'), summary(noteB, 'Note B')]),
      loadNote: vi.fn(async (id) => documents.get(id)!),
    })
    const user = userEvent.setup()
    render(
      <LibraryLayout notes={notes} folders={fakeFolderPort()} system={fakeSystemPort()} links={fakeLinkPort()} />,
    )
    await user.click(await screen.findByRole('button', { name: /Note A/ }))
    await user.click(screen.getByRole('button', { name: '预览视图' }))
    await user.click(await screen.findByRole('link', { name: '[[Note B]]' }))
    expect(await screen.findByRole('heading', { name: 'Note B' })).toBeVisible()
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

  it('does not let a slow initial folder list overwrite a completed create refresh', async () => {
    const initial = deferred<Folder[]>()
    const created: Folder = {
      id: '019c0000-0000-7000-8000-000000000024' as FolderId,
      parentId: null,
      name: '新项目',
      sortOrder: 0,
    }
    const listFolders = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce([created])
    const folders = fakeFolderPort({
      listFolders,
      createFolder: vi.fn().mockResolvedValue(created),
    })
    const user = userEvent.setup()
    render(<LibraryLayout notes={fakeNotePort()} folders={folders} system={fakeSystemPort()} />)

    await user.click(screen.getByRole('button', { name: '新建文件夹' }))
    await user.type(screen.getByRole('textbox', { name: '文件夹名称' }), '新项目{Enter}')
    expect(await screen.findByRole('treeitem', { name: '新项目' })).toBeVisible()
    initial.resolve(folderRows)

    await waitFor(() => expect(screen.getByRole('treeitem', { name: '新项目' })).toBeVisible())
    expect(screen.queryByRole('treeitem', { name: '项目 A' })).not.toBeInTheDocument()
  })

  it('applies authoritative sibling order after moving a folder', async () => {
    const folderC = '019c0000-0000-7000-8000-000000000025' as FolderId
    const initial: Folder[] = [
      ...folderRows,
      { id: folderC, parentId: null, name: '项目 C', sortOrder: 2 },
    ]
    const authoritative: Folder[] = [
      { id: folderC, parentId: null, name: '项目 C', sortOrder: 0 },
      { ...folderRows[1], sortOrder: 1 },
      { ...folderRows[0], parentId: folderB, sortOrder: 0 },
    ]
    const folders = fakeFolderPort({
      listFolders: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(authoritative),
      moveFolder: vi.fn().mockResolvedValue(authoritative[2]),
    })
    render(<LibraryLayout notes={fakeNotePort()} folders={folders} system={fakeSystemPort()} />)
    const source = await screen.findByRole('treeitem', { name: '项目 A' })
    const target = screen.getByRole('treeitem', { name: '项目 B' })

    fireEvent.dragStart(source, { dataTransfer: { setData: vi.fn() } })
    fireEvent.drop(target, { dataTransfer: { getData: () => folderA } })

    await waitFor(() => {
      const labels = screen.getAllByRole('treeitem').map((item) => item.textContent?.trim())
      expect(labels).toEqual(['⌂ 未归档笔记', '▱ 项目 C', '▱ 项目 B', '▱ 项目 A'])
    })
  })

  it('applies authoritative sibling order after deleting a folder', async () => {
    const folderC = '019c0000-0000-7000-8000-000000000026' as FolderId
    const initial: Folder[] = [
      ...folderRows,
      { id: folderC, parentId: null, name: '项目 C', sortOrder: 2 },
    ]
    const authoritative: Folder[] = [
      { id: folderC, parentId: null, name: '项目 C', sortOrder: 0 },
      { ...folderRows[0], sortOrder: 1 },
    ]
    const folders = fakeFolderPort({
      listFolders: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(authoritative),
      deleteEmptyFolder: vi.fn().mockResolvedValue(undefined),
    })
    const user = userEvent.setup()
    render(<LibraryLayout notes={fakeNotePort()} folders={folders} system={fakeSystemPort()} />)
    await user.click(await screen.findByRole('treeitem', { name: '项目 B' }))

    await user.click(screen.getByRole('button', { name: '文件夹更多操作' }))
    await user.click(screen.getByRole('menuitem', { name: '删除空文件夹' }))

    await waitFor(() => {
      const items = screen.getAllByRole('treeitem')
      const labels = items.map((item) => item.textContent?.trim())
      expect(labels).toEqual(['⌂ 未归档笔记', '▱ 项目 C', '▱ 项目 A'])
      expect(items.filter((item) => item.tabIndex === 0)).toHaveLength(1)
    })
  })

  it('distinguishes loading, empty, and safe errors without exposing diagnostics', async () => {
    const pending = deferred<NoteSummary[]>()
    const notes = fakeNotePort({ listNotes: vi.fn().mockReturnValueOnce(pending.promise) })
    const { unmount } = render(
      <LibraryLayout notes={notes} folders={fakeFolderPort()} system={fakeSystemPort()} />,
    )
    expect(screen.getByText('每个念头，都是一座小岛。')).toBeVisible()
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
    const createdFolder: Folder = {
      id: '019c0000-0000-7000-8000-000000000023' as FolderId,
      parentId: null,
      name: '新文件夹',
      sortOrder: 2,
    }
    let currentFolders = [...folderRows]
    const folders = fakeFolderPort({
      listFolders: vi.fn(async () => currentFolders),
      createFolder: vi.fn(async () => {
        currentFolders = [...currentFolders, createdFolder]
        return createdFolder
      }),
      renameFolder: vi.fn(async () => {
        const renamed = { ...folderRows[0], name: '已重命名' }
        currentFolders = currentFolders.map((folder) => (folder.id === folderA ? renamed : folder))
        return renamed
      }),
      moveFolder: vi.fn(async () => {
        const moved = { ...currentFolders.find((folder) => folder.id === folderA)!, parentId: folderB }
        currentFolders = currentFolders.map((folder) => (folder.id === folderA ? moved : folder))
        return moved
      }),
      deleteEmptyFolder: vi.fn(async () => {
        currentFolders = currentFolders.filter((folder) => folder.id !== folderA)
      }),
    })
    render(<LibraryLayout notes={fakeNotePort()} folders={folders} system={fakeSystemPort()} />)
    await screen.findByRole('treeitem', { name: '项目 A' })

    await user.click(screen.getByRole('button', { name: '新建文件夹' }))
    await user.type(screen.getByRole('textbox', { name: '文件夹名称' }), '新文件夹')
    await user.keyboard('{Enter}')
    expect(folders.createFolder).toHaveBeenCalledWith({ parentId: null, name: '新文件夹' })

    await user.click(screen.getByRole('treeitem', { name: '项目 A' }))
    await user.click(screen.getByRole('button', { name: '文件夹更多操作' }))
    await user.click(screen.getByRole('menuitem', { name: '重命名文件夹' }))
    const rename = screen.getByRole('textbox', { name: '重命名文件夹' })
    await user.clear(rename)
    await user.type(rename, '已重命名{Enter}')
    expect(folders.renameFolder).toHaveBeenCalledWith(folderA, '已重命名')

    const source = screen.getByRole('treeitem', { name: '已重命名' })
    const target = screen.getByRole('treeitem', { name: '项目 B' })
    fireEvent.dragStart(source, { dataTransfer: { setData: vi.fn() } })
    fireEvent.drop(target, { dataTransfer: { getData: () => folderA } })
    await waitFor(() => expect(folders.moveFolder).toHaveBeenCalledWith(folderA, folderB))

    await user.click(screen.getByRole('treeitem', { name: '已重命名' }))
    await user.click(screen.getByRole('button', { name: '文件夹更多操作' }))
    await user.click(screen.getByRole('menuitem', { name: '删除空文件夹' }))
    expect(folders.deleteEmptyFolder).toHaveBeenCalledWith(folderA)
  })
})
