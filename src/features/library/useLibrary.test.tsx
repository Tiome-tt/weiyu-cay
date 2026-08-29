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
