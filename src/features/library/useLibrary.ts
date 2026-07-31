import { useCallback, useEffect, useRef, useState } from 'react'
import type { Folder, FolderId, NoteDocument, NoteId, NoteSummary } from '../../domain/model'
import type { FolderPort, NotePort } from '../../domain/ports'

export type LibraryNotePort = Pick<NotePort, 'listNotes' | 'loadNote'>

type LoadState = 'loading' | 'ready' | 'error'

export function useLibrary(notesPort: LibraryNotePort, foldersPort: FolderPort) {
  const [folders, setFolders] = useState<Folder[]>([])
  const [folderState, setFolderState] = useState<LoadState>('loading')
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [noteListState, setNoteListState] = useState<LoadState>('loading')
  const [documentState, setDocumentState] = useState<LoadState>('ready')
  const [activeFolderId, setActiveFolderId] = useState<FolderId | null>(null)
  const [activeNoteId, setActiveNoteId] = useState<NoteId | null>(null)
  const [document, setDocument] = useState<NoteDocument | null>(null)
  const folderListRequest = useRef(0)
  const noteListRequest = useRef(0)
  const noteRequest = useRef(0)

  const refreshFolders = useCallback(async () => {
    const request = ++folderListRequest.current
    setFolderState('loading')
    try {
      const result = await foldersPort.listFolders()
      if (folderListRequest.current !== request) return
      setFolders(result)
      setFolderState('ready')
    } catch {
      if (folderListRequest.current !== request) return
      setFolderState('error')
    }
  }, [foldersPort])

  useEffect(() => {
    void refreshFolders()
  }, [refreshFolders])

  useEffect(() => {
    const request = ++noteListRequest.current
    setNoteListState('loading')
    setNotes([])
    void notesPort
      .listNotes(activeFolderId)
      .then((result) => {
        if (noteListRequest.current !== request) return
        setNotes(result)
        setNoteListState('ready')
      })
      .catch(() => {
        if (noteListRequest.current !== request) return
        setNoteListState('error')
      })
  }, [activeFolderId, notesPort])

  const selectFolder = useCallback((id: FolderId | null) => {
    noteRequest.current += 1
    setActiveFolderId(id)
    setActiveNoteId(null)
    setDocument(null)
    setDocumentState('ready')
  }, [])

  const selectNote = useCallback(
    (id: NoteId) => {
      const request = ++noteRequest.current
      setActiveNoteId(id)
      setDocument(null)
      setDocumentState('loading')
      void notesPort
        .loadNote(id)
        .then((result) => {
          if (noteRequest.current !== request) return
          setDocument(result)
          setDocumentState('ready')
        })
        .catch(() => {
          if (noteRequest.current !== request) return
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

  const deleteFolder = useCallback(
    async (id: FolderId) => {
      await foldersPort.deleteEmptyFolder(id)
      if (activeFolderId === id) selectFolder(null)
      await refreshFolders()
    },
    [activeFolderId, foldersPort, refreshFolders, selectFolder],
  )

  return {
    folders,
    folderState,
    notes,
    noteListState,
    documentState,
    activeFolderId,
    activeNoteId,
    document,
    selectFolder,
    selectNote,
    createFolder,
    renameFolder,
    moveFolder,
    deleteFolder,
  }
}
