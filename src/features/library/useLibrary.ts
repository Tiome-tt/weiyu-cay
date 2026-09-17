import type { NewNoteFormat } from '../../domain/content'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Folder, FolderId, NoteDocument, NoteId, NoteSummary } from '../../domain/model'
import type { FolderPort, NotePort, StartupGuidePort } from '../../domain/ports'

export type LibraryNotePort = Pick<NotePort, 'createNote' | 'listNotes' | 'loadNote' | 'saveNote' | 'renameNote' | 'moveNote' | 'reorderNotes'>

type LoadState = 'loading' | 'ready' | 'error'

const DOCUMENT_CACHE_LIMIT = 8

export function useLibrary(
  notesPort: LibraryNotePort,
  foldersPort: FolderPort,
  startupGuide?: StartupGuidePort,
) {
  const [folders, setFolders] = useState<Folder[]>([])
  const [folderState, setFolderState] = useState<LoadState>('loading')
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [notesByFolder, setNotesByFolder] = useState<Record<string, NoteSummary[]>>({})
  const notesByFolderRef = useRef<Record<string, NoteSummary[]>>({})
  const documentCacheRef = useRef(new Map<NoteId, NoteDocument>())
  const [folderNoteErrors, setFolderNoteErrors] = useState<Record<string, boolean>>({})
  const [noteListState, setNoteListState] = useState<LoadState>('loading')
  const [documentState, setDocumentState] = useState<LoadState>('ready')
  const [activeFolderId, setActiveFolderId] = useState<FolderId | null>(null)
  const [activeNoteId, setActiveNoteId] = useState<NoteId | null>(null)
  const [document, setDocument] = useState<NoteDocument | null>(null)
  notesByFolderRef.current = notesByFolder
  const folderListRequest = useRef(0)
  const noteListRequest = useRef(0)
  const noteRequest = useRef(0)
  const folderNoteRequests = useRef(new Map<string, number>())
  const deletionSequence = useRef(0)
  const noteDeletions = useRef(new Map<NoteId, number>())
  const activeFolderRef = useRef<FolderId | null>(null)
  const mountedRef = useRef(false)
  const pendingStartupGuide = useRef<Awaited<ReturnType<StartupGuidePort['loadTarget']>>>(null)

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

  const refreshNotes = useCallback(async (folderId = activeFolderRef.current, cacheOnly = false) => {
    if (!mountedRef.current) return
    const deletedBeforeRead = deletionSequence.current
    const key = folderKey(folderId)
    const folderRequest = (folderNoteRequests.current.get(key) ?? 0) + 1
    folderNoteRequests.current.set(key, folderRequest)
    const request = cacheOnly ? noteListRequest.current : ++noteListRequest.current
    if (!cacheOnly) setNoteListState('loading')
    try {
      const result = (await notesPort.listNotes(folderId)).filter(
        (note) => (noteDeletions.current.get(note.id) ?? 0) <= deletedBeforeRead,
      )
      if (!mountedRef.current || folderNoteRequests.current.get(key) !== folderRequest) return
      if (!cacheOnly && noteListRequest.current !== request) return
      setFolderNoteErrors((current) => ({ ...current, [key]: false }))
      setNotesByFolder((current) => ({ ...current, [key]: result }))
      if (cacheOnly) return
      setNotes(result)
      setNoteListState('ready')
    } catch {
      if (!mountedRef.current || folderNoteRequests.current.get(key) !== folderRequest) return
      setFolderNoteErrors((current) => ({ ...current, [key]: true }))
      if (!cacheOnly && noteListRequest.current === request) setNoteListState('error')
    }
  }, [notesPort])

  useEffect(() => {
    const cached = notesByFolderRef.current[folderKey(activeFolderId)]
    if (cached !== undefined) {
      setNotes(cached)
      setNoteListState('ready')
      return
    }
    void refreshNotes(activeFolderId)
  }, [activeFolderId, refreshNotes])

  const selectFolder = useCallback((id: FolderId | null) => {
    if (!mountedRef.current) return
    noteListRequest.current += 1
    noteRequest.current += 1
    const cached = notesByFolderRef.current[folderKey(id)]
    activeFolderRef.current = id
    setActiveFolderId(id)
    if (cached !== undefined) {
      setNotes(cached)
      setNoteListState('ready')
    } else {
      setNotes([])
      setNoteListState('loading')
    }
    setActiveNoteId(null)
    setDocument(null)
    setDocumentState('ready')
  }, [])

  const selectNote = useCallback(
    (id: NoteId) => {
      if (!mountedRef.current) return
      const request = ++noteRequest.current
      const cached = documentCacheRef.current.get(id)
      if (cached !== undefined) rememberDocument(documentCacheRef.current, cached)
      setActiveNoteId(id)
      if (cached === undefined) {
        setDocument(null)
        setDocumentState('loading')
      } else {
        setDocument(cached)
        setDocumentState('ready')
      }
      void notesPort
        .loadNote(id)
        .then((result) => {
          rememberDocument(documentCacheRef.current, result)
          if (!mountedRef.current || noteRequest.current !== request) return
          setDocument(result)
          setDocumentState('ready')
        })
        .catch(() => {
          if (!mountedRef.current || noteRequest.current !== request) return
          if (cached === undefined) setDocumentState('error')
        })
    },
    [notesPort],
  )

  useEffect(() => {
    if (startupGuide === undefined) return
    let current = true
    const initialNavigation = noteRequest.current
    void startupGuide.loadTarget().then((target) => {
      if (!current || target === null || noteRequest.current !== initialNavigation) return
      pendingStartupGuide.current = target
      selectFolder(target.folderId)
      selectNote(target.noteId)
    }).catch(() => undefined)
    return () => {
      current = false
    }
  }, [selectFolder, selectNote, startupGuide])

  useEffect(() => {
    const target = pendingStartupGuide.current
    if (
      startupGuide === undefined
      || target === null
      || documentState !== 'ready'
      || document?.id !== target.noteId
    ) return
    pendingStartupGuide.current = null
    void startupGuide.completeTarget(target).catch(() => undefined)
  }, [document, documentState, startupGuide])
  const createFolder = useCallback(
    async (parentId: FolderId | null, name: string) => {
      await foldersPort.createFolder({ parentId, name })
      await refreshFolders()
    },
    [foldersPort, refreshFolders],
  )

  const createNote = useCallback(async (title: string, folderId: FolderId | null = activeFolderId, format?: NewNoteFormat) => {
    const request = ++noteRequest.current
    const created = await notesPort.createNote({ folderId, title, ...(format ? { format } : {}) })
    if (!mountedRef.current || noteRequest.current !== request) return created
    activeFolderRef.current = folderId
    setActiveFolderId(folderId)
    setActiveNoteId(created.id)
    rememberDocument(documentCacheRef.current, created)
    setDocument(created)
    setDocumentState('ready')
    await refreshNotes(folderId)
    return created
  }, [activeFolderId, notesPort, refreshNotes])

  const renameNote = useCallback(async (id: NoteId, title: string) => {
    const result = await notesPort.renameNote(id, title)
    if (!mountedRef.current || result.document.id !== id) return result
    rememberDocument(documentCacheRef.current, result.document)
    if (activeNoteId === id) {
      setDocument(result.document)
      setDocumentState('ready')
    }
    await refreshNotes()
    return result
  }, [activeNoteId, notesPort, refreshNotes])

  const moveNote = useCallback(async (id: NoteId, folderId: FolderId | null) => {
    const navigation = noteRequest.current
    const sourceKeys = Object.entries(notesByFolder)
      .filter(([, items]) => items.some((note) => note.id === id))
      .map(([key]) => key)
    if (document?.id === id) sourceKeys.push(folderKey(document.folderId))
    const authoritative = await notesPort.moveNote(id, folderId)
    if (!mountedRef.current || authoritative.id !== id) return authoritative
    rememberDocument(documentCacheRef.current, authoritative)
    if (activeNoteId === id && noteRequest.current === navigation) {
      setDocument(authoritative)
      setDocumentState('ready')
    }
    // Invalidate only this move's folders so unrelated destination reads can finish.
    const destinationKey = folderKey(authoritative.folderId)
    for (const key of new Set([...sourceKeys, destinationKey])) {
      folderNoteRequests.current.set(key, (folderNoteRequests.current.get(key) ?? 0) + 1)
    }
    const movedSummary: NoteSummary = {
      id: authoritative.id,
      kind: authoritative.kind,
      title: authoritative.title,
      folderId: authoritative.folderId,
      tags: authoritative.tags,
      revision: authoritative.revision,
      createdAt: authoritative.createdAt,
      updatedAt: authoritative.updatedAt,
      excerpt: '',
      content: authoritative.content,
    }
    const currentFolder = activeFolderRef.current
    setNotes((current) => {
      const previous = current.find((note) => note.id === id)
      const remaining = current.filter((note) => note.id !== id)
      return currentFolder === authoritative.folderId
        ? [...remaining, { ...movedSummary, excerpt: previous?.excerpt ?? '' }]
        : remaining
    })
    // Update complete cached lists from the durable result even if re-reading fails.
    // An unvisited folder still needs a full read; one moved note is not its full list.
    setNotesByFolder((current) => {
      const previous = Object.values(current).flat().find((note) => note.id === id)
      return Object.fromEntries(Object.entries(current).map(([key, items]) => {
        const remaining = items.filter((note) => note.id !== id)
        return [key, key === destinationKey
          ? [...remaining, { ...movedSummary, excerpt: previous?.excerpt ?? '' }]
          : remaining]
      }))
    })
    await Promise.all([
      refreshNotes(currentFolder),
      ...(currentFolder === authoritative.folderId ? [] : [refreshNotes(authoritative.folderId, true)]),
    ])
    return authoritative
  }, [activeNoteId, document, notesByFolder, notesPort, refreshNotes])

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
    // Inline folder note lists can be reordered while another folder is active.
    // Refresh the list that was changed; refreshing only activeFolderId leaves the
    // dragged row visibly in its old position until the user revisits the folder.
    await refreshNotes(folderId, folderId !== activeFolderRef.current)
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
    async (id: FolderId): Promise<string | void> => {
      const deletedFolderIds = new Set<FolderId>([id])
      let changed = true
      while (changed) {
        changed = false
        for (const folder of folders) {
          if (folder.parentId !== null && deletedFolderIds.has(folder.parentId) && !deletedFolderIds.has(folder.id)) {
            deletedFolderIds.add(folder.id)
            changed = true
          }
        }
      }
      const operationId = foldersPort.deleteFolder !== undefined
        ? await foldersPort.deleteFolder(id)
        : await foldersPort.deleteEmptyFolder(id)
      setNotesByFolder((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key === '__unfiled__' || !deletedFolderIds.has(key as FolderId))))
      setNotes((current) => current.filter((note) => note.folderId === null || !deletedFolderIds.has(note.folderId)))
      if (activeFolderId !== null && deletedFolderIds.has(activeFolderId)) selectFolder(null)
      await refreshFolders()
      return operationId
    },
    [activeFolderId, folders, foldersPort, refreshFolders, selectFolder],
  )

  const adoptDocument = useCallback((authoritative: NoteDocument) => {
    if (!mountedRef.current) return
    if (authoritative.id !== activeNoteId) return
    rememberDocument(documentCacheRef.current, authoritative)
    setDocument(authoritative)
    setDocumentState('ready')
    const summary: NoteSummary = {
      id: authoritative.id,
      kind: authoritative.kind,
      title: authoritative.title,
      folderId: authoritative.folderId,
      tags: authoritative.tags,
      revision: authoritative.revision,
      createdAt: authoritative.createdAt,
      updatedAt: authoritative.updatedAt,
      excerpt: '',
      content: authoritative.content,
    }
    setNotes((current) => current.map((note) => note.id === authoritative.id ? { ...summary, excerpt: note.excerpt } : note))
    setNotesByFolder((current) => Object.fromEntries(Object.entries(current).map(([key, items]) => [
      key,
      items.map((note) => note.id === authoritative.id ? { ...summary, excerpt: note.excerpt } : note),
    ])))
  }, [activeNoteId])

  const clearDeletedNote = useCallback((id: NoteId) => {
    if (!mountedRef.current) return
    noteRequest.current += 1
    noteListRequest.current += 1
    // Filter only deletions newer than a read; later undo/recovery reads remain valid.
    noteDeletions.current.set(id, ++deletionSequence.current)
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
    documentCacheRef.current.delete(id)
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
    folderNoteErrors,
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

function rememberDocument(cache: Map<NoteId, NoteDocument>, document: NoteDocument) {
  cache.delete(document.id)
  cache.set(document.id, document)
  if (cache.size <= DOCUMENT_CACHE_LIMIT) return
  const oldest = cache.keys().next().value
  if (oldest !== undefined) cache.delete(oldest)
}
function folderKey(folderId: FolderId | null): string {
  return folderId ?? '__unfiled__'
}
