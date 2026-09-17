import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderId, NoteDocument, NoteId, NoteSummary } from '../../domain/model'
import { fakeFolderPort, fakeNotePort, note } from '../../test/fakes'
import { useLibrary } from './useLibrary'

const folderA = '019c0000-0000-7000-8000-000000000121' as FolderId
const folderB = '019c0000-0000-7000-8000-000000000122' as FolderId

afterEach(cleanup)

describe('useLibrary createNote', () => {
  it('uses an explicit target folder instead of the active folder', async () => {
    const createNote = vi.fn().mockResolvedValue({ ...note(''), folderId: folderB })
    const notes = fakeNotePort({ createNote })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))
    act(() => hook.result.current.selectFolder(folderA))
    await waitFor(() => expect(hook.result.current.activeFolderId).toBe(folderA))

    await act(async () => hook.result.current.createNote('目标目录', folderB))

    expect(createNote).toHaveBeenCalledWith({ folderId: folderB, title: '目标目录' })
  })

  it('falls back to the active folder when no target folder is passed', async () => {
    const createNote = vi.fn().mockResolvedValue({ ...note(''), folderId: folderA })
    const notes = fakeNotePort({ createNote })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))
    act(() => hook.result.current.selectFolder(folderA))
    await waitFor(() => expect(hook.result.current.activeFolderId).toBe(folderA))

    await act(async () => hook.result.current.createNote('当前目录'))

    expect(createNote).toHaveBeenCalledWith({ folderId: folderA, title: '当前目录' })
  })

  it('switches to an explicit root target and refreshes that root note list', async () => {
    const createNote = vi.fn().mockResolvedValue({ ...note(''), folderId: null })
    const listNotes = vi.fn().mockResolvedValue([])
    const notes = fakeNotePort({ createNote, listNotes })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))
    act(() => hook.result.current.selectFolder(folderA))
    await waitFor(() => expect(hook.result.current.activeFolderId).toBe(folderA))

    await act(async () => hook.result.current.createNote('根目录笔记', null))

    expect(hook.result.current.activeFolderId).toBeNull()
    expect(listNotes).toHaveBeenLastCalledWith(null)
  })

  it('removes a deleted note from every cached folder list', async () => {
    const rootNote = { ...note('root'), id: '019c0000-0000-7000-8000-000000000131' as NoteId, folderId: null, title: '根目录笔记' }
    const folderNote = { ...note('folder'), id: '019c0000-0000-7000-8000-000000000132' as NoteId, folderId: folderA, title: '文件夹笔记' }
    const toSummary = ({ markdown, ...summary }: NoteDocument): NoteSummary => ({ ...summary, excerpt: markdown })
    const listNotes = vi.fn(async (folderId: FolderId | null) => folderId === null ? [toSummary(rootNote)] : [toSummary(folderNote)])
    const notes = fakeNotePort({ listNotes })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))

    await waitFor(() => expect(hook.result.current.notesByFolder['__unfiled__']).toHaveLength(1))
    act(() => hook.result.current.selectFolder(folderA))
    await waitFor(() => expect(hook.result.current.notesByFolder[folderA]).toHaveLength(1))

    act(() => hook.result.current.clearDeletedNote(folderNote.id))

    expect(hook.result.current.notesByFolder[folderA]).toEqual([])
    expect(hook.result.current.notes).toEqual([])
  })
})

describe('useLibrary folder note cache', () => {
  it('reuses a loaded folder list immediately without reading it again', async () => {
    const first = { ...note('first'), id: '019c0000-0000-7000-8000-000000000141' as NoteId, folderId: folderA, title: '项目 A 笔记', excerpt: 'first' }
    const second = { ...note('second'), id: '019c0000-0000-7000-8000-000000000142' as NoteId, folderId: folderB, title: '项目 B 笔记', excerpt: 'second' }
    const listNotes = vi.fn(async (folderId: FolderId | null) => folderId === folderA ? [first] : folderId === folderB ? [second] : [])
    const notes = fakeNotePort({ listNotes })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))

    await waitFor(() => expect(listNotes).toHaveBeenCalledWith(null))

    act(() => hook.result.current.selectFolder(folderA))
    await waitFor(() => expect(hook.result.current.notesByFolder[folderA]).toEqual([first]))
    const readsAfterFirstFolder = listNotes.mock.calls.length

    act(() => hook.result.current.selectFolder(folderB))
    await waitFor(() => expect(hook.result.current.notesByFolder[folderB]).toEqual([second]))
    const readsAfterSecondFolder = listNotes.mock.calls.length

    act(() => hook.result.current.selectFolder(folderA))
    expect(hook.result.current.notes).toEqual([first])
    expect(hook.result.current.noteListState).toBe('ready')
    await waitFor(() => expect(listNotes).toHaveBeenCalledTimes(readsAfterSecondFolder))
    expect(readsAfterFirstFolder).toBeLessThan(readsAfterSecondFolder)
  })
})
describe('useLibrary document cache', () => {
  it('shows a previously loaded document while revalidating it in the background', async () => {
    const first = { ...note('first body'), title: '缓存笔记' }
    const refreshed = { ...first, markdown: 'refreshed body', revision: first.revision + 1 }
    let finishRefresh!: (document: NoteDocument) => void
    const loadNote = vi.fn()
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => new Promise<NoteDocument>((resolve) => { finishRefresh = resolve }))
    const notes = fakeNotePort({ loadNote, listNotes: vi.fn().mockResolvedValue([]) })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))

    act(() => hook.result.current.selectNote(first.id))
    await waitFor(() => expect(hook.result.current.document?.markdown).toBe('first body'))

    act(() => hook.result.current.selectNote(first.id))
    expect(hook.result.current.document?.markdown).toBe('first body')
    expect(hook.result.current.documentState).toBe('ready')
    expect(loadNote).toHaveBeenCalledTimes(2)

    await act(async () => { finishRefresh(refreshed) })
    await waitFor(() => expect(hook.result.current.document?.markdown).toBe('refreshed body'))
  })
})
describe('useLibrary reorderNotes', () => {
  it('refreshes the folder that was reordered even when it is not active', async () => {
    const reorderedId = note('').id
    const listNotes = vi.fn(async (folderId: FolderId | null) => folderId === folderB ? [{ ...note(''), id: reorderedId, folderId: folderB, excerpt: '' }] : [])
    const reorderNotes = vi.fn().mockResolvedValue(undefined)
    const notes = fakeNotePort({ listNotes, reorderNotes })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))
    await waitFor(() => expect(hook.result.current.notesByFolder['__unfiled__']).toEqual([]))

    await act(async () => hook.result.current.reorderNotes(folderB, [reorderedId]))

    expect(reorderNotes).toHaveBeenCalledWith(folderB, [reorderedId])
    expect(listNotes).toHaveBeenLastCalledWith(folderB)
    expect(hook.result.current.notesByFolder[folderB]).toHaveLength(1)
  })
})

describe('useLibrary moveNote', () => {
  it('exposes a failed uncached destination read without inventing an incomplete list', async () => {
    const notes = fakeNotePort({
      listNotes: vi.fn(async (id) => {
        if (id === folderB) throw new Error('read failed')
        return []
      }),
      moveNote: vi.fn(async () => ({ ...note('body'), folderId: folderB })),
    })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))
    await waitFor(() => expect(hook.result.current.noteListState).toBe('ready'))
    await act(async () => hook.result.current.moveNote(note('').id, folderB))
    expect(hook.result.current.notesByFolder[folderB]).toBeUndefined()
    expect(hook.result.current.folderNoteErrors[folderB]).toBe(true)
  })

  it.each(['move', 'delete'])('keeps unrelated destination refreshes alive during concurrent %s', async (operation) => {
    let finishB!: (items: NoteSummary[]) => void
    const folderC = '019c0000-0000-7000-8000-000000000123' as FolderId
    const first = { ...note('one'), folderId: folderB, excerpt: 'one' }
    const second = { ...note('two'), id: '019c0000-0000-7000-8000-000000000134' as NoteId, folderId: folderC, excerpt: 'two' }
    const notes = fakeNotePort({
      moveNote: vi.fn(async (id) => id === first.id ? first : second),
      listNotes: vi.fn(async (id) => id === folderB
        ? new Promise<NoteSummary[]>((resolve) => { finishB = resolve })
        : id === folderC ? [second] : []),
    })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))
    act(() => hook.result.current.selectFolder(folderA))
    await waitFor(() => expect(hook.result.current.noteListState).toBe('ready'))
    let moving!: Promise<NoteDocument>
    act(() => { moving = hook.result.current.moveNote(first.id, folderB) })
    await waitFor(() => expect(notes.listNotes).toHaveBeenCalledWith(folderB))
    if (operation === 'move') await act(async () => hook.result.current.moveNote(second.id, folderC))
    else act(() => hook.result.current.clearDeletedNote(second.id))
    await act(async () => { finishB([first]); await moving })
    expect(hook.result.current.notesByFolder[folderB]).toEqual([first])
    if (operation === 'move') expect(hook.result.current.notesByFolder[folderC]).toEqual([second])
  })

  it('keeps a durable move visible in cached folders even if the follow-up read fails', async () => {
    const original = {
      ...note('body'),
      folderId: folderA,
      excerpt: 'body',
      content: {
        type: 'file' as const,
        file: {
          storageName: '019c0000.pdf',
          originalName: '资料.pdf',
          mediaType: 'application/pdf',
          size: 128,
          sha256: 'abc',
        },
      },
    }
    let moved = false
    const notes = fakeNotePort({
      listNotes: vi.fn(async (id) => {
        if (moved) throw new Error('index temporarily unavailable')
        return id === folderA ? [original] : []
      }),
      moveNote: vi.fn(async () => { moved = true; return { ...original, folderId: folderB } }),
    })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))
    act(() => hook.result.current.selectFolder(folderB))
    await waitFor(() => expect(hook.result.current.notesByFolder[folderB]).toEqual([]))
    act(() => hook.result.current.selectFolder(folderA))
    await waitFor(() => expect(hook.result.current.notesByFolder[folderA]).toHaveLength(1))
    await act(async () => hook.result.current.moveNote(original.id, folderB))
    expect(hook.result.current.notesByFolder[folderA]).toEqual([])
    expect(hook.result.current.notesByFolder[folderB]).toEqual([expect.objectContaining({
      id: original.id, title: original.title, folderId: folderB, content: original.content,
    })])
  })

  it('does not let a pending destination refresh resurrect a deleted note', async () => {
    let finishList!: (notes: NoteSummary[]) => void
    const moved = { ...note('body'), folderId: folderB }
    const notes = fakeNotePort({
      listNotes: vi.fn(async (id) => id === folderB
        ? new Promise<NoteSummary[]>((resolve) => { finishList = resolve })
        : []),
      moveNote: vi.fn(async () => moved),
    })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))
    await waitFor(() => expect(hook.result.current.noteListState).toBe('ready'))
    let moving!: Promise<NoteDocument>
    act(() => { moving = hook.result.current.moveNote(moved.id, folderB) })
    await waitFor(() => expect(notes.listNotes).toHaveBeenCalledWith(folderB))
    act(() => hook.result.current.clearDeletedNote(moved.id))
    await act(async () => { finishList([{ ...moved, excerpt: 'body' }]); await moving })
    expect(hook.result.current.notesByFolder[folderB] ?? []).toEqual([])

    // A fresh read after undo may legitimately contain the restored note again.
    let restored!: Promise<void>
    act(() => { restored = hook.result.current.refreshNotes(folderB, true) })
    await act(async () => { finishList([{ ...moved, excerpt: 'body' }]); await restored })
    expect(hook.result.current.notesByFolder[folderB]).toEqual([{ ...moved, excerpt: 'body' }])
  })

  it.each([false, true])('refreshes both folder lists without another click (cached destination: %s)', async (cachedDestination) => {
    let stored: NoteDocument = { ...note('body'), folderId: folderA }
    const summary = (): NoteSummary => ({ ...stored, excerpt: 'body' })
    const listNotes = vi.fn(async (id: FolderId | null) => id === stored.folderId ? [summary()] : [])
    const notes = fakeNotePort({
      listNotes,
      loadNote: vi.fn(async () => stored),
      moveNote: vi.fn(async (_id, folderId) => (stored = { ...stored, folderId })),
    })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))
    if (cachedDestination) {
      act(() => hook.result.current.selectFolder(folderB))
      await waitFor(() => expect(hook.result.current.notesByFolder[folderB]).toEqual([]))
    }
    act(() => hook.result.current.selectFolder(folderA))
    await waitFor(() => expect(hook.result.current.notesByFolder[folderA]).toHaveLength(1))
    act(() => hook.result.current.selectNote(stored.id))
    await waitFor(() => expect(hook.result.current.document?.folderId).toBe(folderA))

    await act(async () => hook.result.current.moveNote(stored.id, folderB))

    expect(hook.result.current.notesByFolder[folderA]).toEqual([])
    expect(hook.result.current.notesByFolder[folderB]).toEqual([summary()])
    expect(hook.result.current.notes).toEqual([])
    expect(hook.result.current.document?.folderId).toBe(folderB)
    expect(hook.result.current.activeFolderId).toBe(folderA)

    await act(async () => hook.result.current.moveNote(stored.id, folderA))
    expect(hook.result.current.notesByFolder[folderB]).toEqual([])
    expect(hook.result.current.notesByFolder[folderA]).toEqual([summary()])
    expect(hook.result.current.notes).toEqual([summary()])
  })

  it('does not replace a newly selected document when a move finishes late', async () => {
    let finishMove!: (document: NoteDocument) => void
    const original = { ...note('body'), folderId: folderA }
    const other = { ...note('other'), id: '019c0000-0000-7000-8000-000000000133' as NoteId, folderId: folderB }
    const notes = fakeNotePort({
      loadNote: vi.fn(async (id) => id === original.id ? original : other),
      moveNote: vi.fn(() => new Promise<NoteDocument>((resolve) => { finishMove = resolve })),
      listNotes: vi.fn(async () => []),
    })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))
    act(() => { hook.result.current.selectFolder(folderA); hook.result.current.selectNote(original.id) })
    await waitFor(() => expect(hook.result.current.document?.id).toBe(original.id))
    let moving!: Promise<NoteDocument>
    act(() => { moving = hook.result.current.moveNote(original.id, folderB) })
    act(() => { hook.result.current.selectFolder(folderB); hook.result.current.selectNote(other.id) })
    await waitFor(() => expect(hook.result.current.document?.id).toBe(other.id))

    await act(async () => { finishMove({ ...original, folderId: folderB }); await moving })

    expect(hook.result.current.document?.id).toBe(other.id)
    expect(hook.result.current.activeFolderId).toBe(folderB)
    expect(notes.listNotes).toHaveBeenLastCalledWith(folderB)
  })
})
