import { useCallback, useEffect, useRef, useState } from 'react'
import type { Folder, FolderId, NoteDocument, NoteId, NoteSummary } from '../../domain/model'
import type { FolderPort, NotePort } from '../../domain/ports'

export type LibraryNotePort = Pick<NotePort, 'createNote' | 'listNotes' | 'loadNote' | 'saveNote' | 'renameNote' | 'moveNote' | 'reorderNotes'>

type LoadState = 'loading' | 'ready' | 'error'

export function useLibrary(notesPort: LibraryNotePort, foldersPort: FolderPort) {
  const [folders, setFolders] = useState<Folder[]>([])
  const [folderState, setFolderState] = useState<LoadState>('loading')
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [notesByFolder, setNotesByFolder] = useState<Record<string, NoteSummary[]>>({})
  const [noteListState, setNoteListState] = useState<LoadState>('loading')
  const [documentState, setDocumentState] = useState<LoadState>('ready')
  const [activeFolderId, setActiveFolderId] = useState<FolderId | null>(null)
  const [activeNoteId, setActiveNoteId] = useState<NoteId | null>(null)
  const [document, setDocument] = useState<NoteDocument | null>(null)
  const folderListRequest = useRef(0)
  const noteListRequest = useRef(0)
  const noteRequest = useRef(0)
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      folderListRequest.current += 1
      noteListRequest.current += 1
      noteRequest.current += 1
    }
  }, [])

  const refreshFolders = useCallback(async () => {
    if (!mountedRef.current) return
    const request = ++folderListRequest.current
    setFolderState('loading')
    try {
      const result = await foldersPort.listFolders()
      if (!mountedRef.current || folderListRequest.current !== request) return
      setFolders(result)
      setFolderState('ready')
    } catch {
      if (!mountedRef.current || folderListRequest.current !== request) return
      setFolderState('error')
    }
  }, [foldersPort])

  useEffect(() => {
    void refreshFolders()
  }, [refreshFolders])

  const refreshNotes = useCallback(async (folderId = activeFolderId) => {
    if (!mountedRef.current) return
    const request = ++noteListRequest.current
    setNoteListState('loading')
    try {
      const result = await notesPort.listNotes(folderId)
      if (!mountedRef.current || noteListRequest.current !== request) return
      setNotes(result)
      setNotesByFolder((current) => ({ ...current, [folderKey(folderId)]: result }))
      setNoteListState('ready')
    } catch {
      if (!mountedRef.current || noteListRequest.current !== request) return
      setNoteListState('error')
    }
  }, [activeFolderId, notesPort])

  useEffect(() => {
    void refreshNotes()
  }, [refreshNotes])

  const selectFolder = useCallback((id: FolderId | null) => {
    if (!mountedRef.current) return
    noteListRequest.current += 1
    noteRequest.current += 1
    setActiveFolderId(id)
    setActiveNoteId(null)
    setDocument(null)
    setDocumentState('ready')
  }, [])

  const selectNote = useCallback(
    (id: NoteId) => {
      if (!mountedRef.current) return
      const request = ++noteRequest.current
      setActiveNoteId(id)
      setDocument(null)
      setDocumentState('loading')
      void notesPort
        .loadNote(id)
        .then((result) => {
          if (!mountedRef.current || noteRequest.current !== request) return
          setDocument(result)
          setDocumentState('ready')
        })
        .catch(() => {
          if (!mountedRef.current || noteRequest.current !== request) return
          setDocumentState('error')
        })
    },
    [notesPort],
  )

  const createFolder = useCallback(
    async (parentId: FolderId | null, name: string) => {
      await foldersPort.createFolder({ parentId, name })
      await refreshFolders()
    },
    [foldersPort, refreshFolders],
  )

  const createNote = useCallback(async (title: string, folderId: FolderId | null = activeFolderId) => {
    const request = ++noteRequest.current
    const created = await notesPort.createNote({ folderId, title })
    if (!mountedRef.current || noteRequest.current !== request) return created
    setActiveFolderId(folderId)
    setActiveNoteId(created.id)
    setDocument(created)
    setDocumentState('ready')
    await refreshNotes(folderId)
    return created
  }, [activeFolderId, notesPort, refreshNotes])

  const renameNote = useCallback(async (id: NoteId, title: string) => {
    const result = await notesPort.renameNote(id, title)
    if (!mountedRef.current || result.document.id !== id) return result
    if (activeNoteId === id) {
      setDocument(result.document)
      setDocumentState('ready')
    }
    await refreshNotes()
    return result
  }, [activeNoteId, notesPort, refreshNotes])

  const moveNote = useCallback(async (id: NoteId, folderId: FolderId | null) => {
    const authoritative = await notesPort.moveNote(id, folderId)
    if (!mountedRef.current || authoritative.id !== id) return authoritative
    if (activeNoteId === id) {
      setDocument(authoritative)
      setDocumentState('ready')
    }
    await refreshNotes()
    return authoritative
  }, [activeNoteId, notesPort, refreshNotes])

  const renameFolder = useCallback(
    async (id: FolderId, name: string) => {
      await foldersPort.renameFolder(id, name)
      await refreshFolders()
    },
    [foldersPort, refreshFolders],
  )

  const moveFolder = useCallback(
    async (id: FolderId, parentId: FolderId | null) => {
      await foldersPort.moveFolder(id, parentId)
      await refreshFolders()
    },
    [foldersPort, refreshFolders],
  )

  const reorderFolders = useCallback(async (parentId: FolderId | null, orderedIds: FolderId[]) => {
    if (foldersPort.reorderFolders === undefined) return
    await foldersPort.reorderFolders(parentId, orderedIds)
    await refreshFolders()
  }, [foldersPort, refreshFolders])

  const reorderNotes = useCallback(async (folderId: FolderId | null, orderedIds: NoteId[]) => {
    if (notesPort.reorderNotes === undefined) return
    await notesPort.reorderNotes(folderId, orderedIds)
    await refreshNotes()
  }, [notesPort, refreshNotes])

  const toggleFolderStar = useCallback(
    async (id: FolderId, starred: boolean) => {
      if (foldersPort.setFolderStarred === undefined) return
      await foldersPort.setFolderStarred(id, starred)
      await refreshFolders()
    },
    [foldersPort, refreshFolders],
  )

  const deleteFolder = useCallback(
    async (id: FolderId) => {
      if (foldersPort.deleteFolder !== undefined) await foldersPort.deleteFolder(id)
      else await foldersPort.deleteEmptyFolder(id)
      if (activeFolderId === id) selectFolder(null)
      await refreshFolders()
    },
    [activeFolderId, foldersPort, refreshFolders, selectFolder],
  )

  const adoptDocument = useCallback((authoritative: NoteDocument) => {
    if (!mountedRef.current) return
    if (authoritative.id !== activeNoteId) return
    setDocument(authoritative)
    setDocumentState('ready')
  }, [activeNoteId])

  const clearDeletedNote = useCallback((id: NoteId) => {
    if (!mountedRef.current) return
    noteRequest.current += 1
    noteListRequest.current += 1
    setNotes((current) => current.filter((note) => note.id !== id))
    setNotesByFolder((current) => {
      let changed = false
      const next = { ...current }
      for (const [key, items] of Object.entries(current)) {
        const filtered = items.filter((note) => note.id !== id)
        if (filtered.length !== items.length) {
          next[key] = filtered
          changed = true
        }
      }
      return changed ? next : current
    })
    if (activeNoteId !== id) return
    setActiveNoteId(null)
    setDocument(null)
    setDocumentState('ready')
  }, [activeNoteId])

  const refreshLibrary = useCallback(async () => {
    await Promise.all([refreshFolders(), refreshNotes()])
  }, [refreshFolders, refreshNotes])

  return {
    folders,
    folderState,
    notes,
    notesByFolder,
    noteListState,
    documentState,
    activeFolderId,
    activeNoteId,
    document,
    selectFolder,
    selectNote,
    createFolder,
    createNote,
    renameNote,
    moveNote,
    renameFolder,
    moveFolder,
    reorderFolders,
    reorderNotes,
    toggleFolderStar,
    deleteFolder,
    adoptDocument,
    clearDeletedNote,
    refreshFolders,
    refreshNotes,
    refreshLibrary,
  }
}

function folderKey(folderId: FolderId | null): string {
  return folderId ?? '__unfiled__'
}
