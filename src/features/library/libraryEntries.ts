import { contentFormat } from '../../domain/content'
import type { Folder, FolderId, NoteSummary } from '../../domain/model'

export type LibraryTypeFilter = 'all' | 'document' | 'markdown' | 'text' | 'pdf' | 'image' | 'office' | 'other'
export type LibrarySortOrder = 'manual' | 'name' | 'updated'
export type LibraryEntryFormat = Exclude<LibraryTypeFilter, 'all'>

export interface LibraryEntryPresentation {
  format: LibraryEntryFormat
  label: string
  extension: string | null
}

const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])
const NAME_COLLATOR = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

export function libraryEntryPresentation(note: NoteSummary): LibraryEntryPresentation {
  const format = contentFormat(note)
  if (format === 'document') return { format, label: '文档', extension: null }
  if (format === 'markdown') return { format, label: 'Markdown', extension: 'MD' }
  if (format === 'text') return { format, label: '纯文本', extension: 'TXT' }

  const managed = note.content?.type === 'file' ? note.content.file : null
  const extension = fileExtension(managed?.originalName ?? note.title)
  const normalizedExtension = extension?.toLowerCase() ?? ''
  const mediaType = managed?.mediaType.toLowerCase() ?? ''
  if (mediaType === 'application/pdf' || normalizedExtension === 'pdf') {
    return { format: 'pdf', label: 'PDF', extension: extension ?? 'PDF' }
  }
  if (mediaType.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp'].includes(normalizedExtension)) {
    return { format: 'image', label: '图片', extension }
  }
  if (OFFICE_EXTENSIONS.has(normalizedExtension)) {
    return { format: 'office', label: 'Office', extension }
  }
  return { format: 'other', label: '附件', extension }
}

export function matchesLibraryType(note: NoteSummary, filter: LibraryTypeFilter): boolean {
  return filter === 'all' || libraryEntryPresentation(note).format === filter
}

export function retainMatchingFolders(
  folders: Folder[],
  notesByFolder: Record<string, NoteSummary[]>,
  filter: LibraryTypeFilter,
  folderNoteErrors: Record<string, boolean> = {},
): Folder[] {
  if (filter === 'all') return folders
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const retained = new Set<FolderId>()
  const retainWithAncestors = (folderId: FolderId) => {
    let folder = byId.get(folderId)
    while (folder !== undefined && !retained.has(folder.id)) {
      retained.add(folder.id)
      folder = folder.parentId === null ? undefined : byId.get(folder.parentId)
    }
  }
  for (const notes of Object.values(notesByFolder)) {
    for (const note of notes) {
      if (!matchesLibraryType(note, filter) || note.folderId === null) continue
      retainWithAncestors(note.folderId)
    }
  }
  for (const [key, failed] of Object.entries(folderNoteErrors)) {
    if (failed && byId.has(key as FolderId)) retainWithAncestors(key as FolderId)
  }
  return folders.filter((folder) => retained.has(folder.id))
}

export function sortLibraryNotes(notes: NoteSummary[], order: LibrarySortOrder): NoteSummary[] {
  if (order === 'manual') return notes
  return notes.slice().sort((left, right) => {
    if (order === 'updated') {
      const leftTime = Date.parse(left.updatedAt)
      const rightTime = Date.parse(right.updatedAt)
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime
      if (left.updatedAt !== right.updatedAt) return right.updatedAt.localeCompare(left.updatedAt)
    }
    return NAME_COLLATOR.compare(left.title, right.title)
  })
}

function fileExtension(name: string): string | null {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return null
  return name.slice(dot + 1).toUpperCase()
}
