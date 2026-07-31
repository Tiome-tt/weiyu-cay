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
  const folderRequest = useRef(0)
  const noteRequest = useRef(0)

  const refreshFolders = useCallback(async () => {
    setFolderState('loading')
    try {
      const result = await foldersPort.listFolders()
      setFolders(result)
      setFolderState('ready')
    } catch {
      setFolderState('error')
    }
  }, [foldersPort])

  useEffect(() => {
    void refreshFolders()
  }, [refreshFolders])

  useEffect(() => {
    const request = ++folderRequest.current
    setNoteListState('loading')
    setNotes([])
    void notesPort
      .listNotes(activeFolderId)
      .then((result) => {
        if (folderRequest.current !== request) return
        setNotes(result)
        setNoteListState('ready')
      })
      .catch(() => {
        if (folderRequest.current !== request) return
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
      const created = await foldersPort.createFolder({ parentId, name })
      setFolders((current) => [...current, created])
    },
    [foldersPort],
  )

  const renameFolder = useCallback(
    async (id: FolderId, name: string) => {
      const renamed = await foldersPort.renameFolder(id, name)
      setFolders((current) => current.map((folder) => (folder.id === id ? renamed : folder)))
    },
    [foldersPort],
  )

  const moveFolder = useCallback(
    async (id: FolderId, parentId: FolderId | null) => {
      const moved = await foldersPort.moveFolder(id, parentId)
      setFolders((current) => current.map((folder) => (folder.id === id ? moved : folder)))
    },
    [foldersPort],
  )

  const deleteFolder = useCallback(
    async (id: FolderId) => {
      await foldersPort.deleteEmptyFolder(id)
      setFolders((current) => current.filter((folder) => folder.id !== id))
      if (activeFolderId === id) selectFolder(null)
    },
    [activeFolderId, foldersPort, selectFolder],
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
