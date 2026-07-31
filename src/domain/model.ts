export type Brand<T, Name extends string> = T & { readonly __brand: Name }

export type NoteId = Brand<string, 'NoteId'>
export type FolderId = Brand<string, 'FolderId'>
export type NoteKind = 'formal' | 'temporary'
export type EditorMode = 'source' | 'split' | 'preview'

export interface NoteDocument {
  id: NoteId
  kind: NoteKind
  title: string
  folderId: FolderId | null
  tags: string[]
  markdown: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface NoteSummary extends Omit<NoteDocument, 'markdown'> {
  excerpt: string
}

export interface Folder {
  id: FolderId
  parentId: FolderId | null
  name: string
  sortOrder: number
}
