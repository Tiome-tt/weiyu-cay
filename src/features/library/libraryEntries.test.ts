import { describe, expect, it } from 'vitest'
import type { Folder, FolderId, NoteId, NoteSummary } from '../../domain/model'
import { libraryEntryPresentation, retainMatchingFolders, sortLibraryNotes } from './libraryEntries'

const folderId = (value: string) => value as FolderId
const note = (
  id: string,
  title: string,
  folder: FolderId,
  updatedAt: string,
  content?: NoteSummary['content'],
): NoteSummary => ({
  id: id as NoteId,
  kind: 'formal',
  title,
  folderId: folder,
  tags: [],
  content,
  revision: 1,
  createdAt: '2026-09-08T00:00:00Z',
  updatedAt,
  excerpt: '',
})

describe('library entry presentation', () => {
  it('distinguishes mixed entries and preserves managed-file extensions', () => {
    expect(libraryEntryPresentation(note('m', 'README', folderId('f'), '2026-09-08T00:00:00Z')))
      .toMatchObject({ format: 'markdown', label: 'Markdown', extension: 'MD' })
    expect(libraryEntryPresentation(note('d', '方案', folderId('f'), '2026-09-08T00:00:00Z', {
      type: 'document',
      document: { schemaVersion: 1, root: { type: 'doc' } },
    }))).toMatchObject({ format: 'document', label: '文档', extension: null })
    expect(libraryEntryPresentation(note('p', '报告', folderId('f'), '2026-09-08T00:00:00Z', {
      type: 'file',
      file: { storageName: 'p', originalName: 'Quarter.Final.PDF', mediaType: 'application/pdf', size: 3, sha256: 'abc' },
    }))).toMatchObject({ format: 'pdf', label: 'PDF', extension: 'PDF' })
    expect(libraryEntryPresentation(note('o', '预算', folderId('f'), '2026-09-08T00:00:00Z', {
      type: 'file',
      file: {
        storageName: 'p',
        originalName: '预算.xlsx',
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 3,
        sha256: 'abc',
      },
    }))).toMatchObject({ format: 'office', label: 'Office', extension: 'XLSX' })
  })
})

describe('library filtering and sorting', () => {
  it('retains every ancestor of a folder containing a matching entry', () => {
    const project = folderId('a')
    const archive = folderId('b')
    const loose = folderId('c')
    const folders: Folder[] = [
      { id: project, parentId: null, name: '项目', sortOrder: 0 },
      { id: archive, parentId: project, name: '归档', sortOrder: 0 },
      { id: loose, parentId: null, name: '随手记', sortOrder: 1 },
    ]
    const notesByFolder = {
      b: [note('pdf', '报告', archive, '2026-09-07T00:00:00Z', {
        type: 'file',
        file: { storageName: 'p', originalName: '报告.pdf', mediaType: 'application/pdf', size: 3, sha256: 'abc' },
      })],
      c: [note('md', '记录', loose, '2026-09-08T00:00:00Z')],
    }

    expect(retainMatchingFolders(folders, notesByFolder, 'pdf').map((folder) => folder.id)).toEqual([project, archive])
  })

  it('keeps unreadable folders and their ancestors visible while a filter is active', () => {
    const project = folderId('a')
    const archive = folderId('b')
    const unrelated = folderId('c')
    const folders: Folder[] = [
      { id: project, parentId: null, name: '项目', sortOrder: 0 },
      { id: archive, parentId: project, name: '归档', sortOrder: 0 },
      { id: unrelated, parentId: null, name: '随手记', sortOrder: 1 },
    ]

    expect(retainMatchingFolders(folders, {}, 'pdf', { b: true }).map((folder) => folder.id))
      .toEqual([project, archive])
  })

  it('sorts only the rendered copy and leaves manual order untouched', () => {
    const folder = folderId('f')
    const original = [
      note('z', '舟', folder, '2026-09-07T00:00:00Z'),
      note('a', '岸', folder, '2026-09-08T00:00:00Z'),
    ]

    expect(sortLibraryNotes(original, 'updated').map((item) => item.id)).toEqual(['a', 'z'])
    expect(sortLibraryNotes(original, 'manual')).toEqual(original)
    expect(original.map((item) => item.id)).toEqual(['z', 'a'])
  })

  it('sorts recently modified entries by instant across timezone offsets', () => {
    const folder = folderId('f')
    const earlier = note('early', '早', folder, '2026-09-08T08:00:00+08:00')
    const later = note('late', '晚', folder, '2026-09-08T00:30:00Z')

    expect(sortLibraryNotes([earlier, later], 'updated').map((item) => item.id)).toEqual(['late', 'early'])
  })
})
