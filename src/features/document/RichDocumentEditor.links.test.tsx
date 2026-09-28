import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { emptyRichDocument } from '../../domain/content'
import type { NoteId, NoteSummary } from '../../domain/model'
import { RichDocumentEditor } from './RichDocumentEditor'

beforeAll(() => {
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.querySelector('.tiptap') })
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(0, 0, 10, 10) })
})
afterEach(cleanup)

const CURRENT = '019c0000-0000-7000-8000-000000000001' as NoteId
function target(id: string, title: string): NoteSummary {
  return {
    id: id as NoteId,
    kind: 'formal',
    title,
    folderId: null,
    tags: [],
    revision: 0,
    createdAt: '2026-09-09T00:00:00Z',
    updatedAt: '2026-09-09T00:00:00Z',
    excerpt: '',
  }
}

describe('RichDocumentEditor internal links', () => {
  it('searches link targets and excludes the current note', async () => {
    const user = userEvent.setup()
    render(<RichDocumentEditor
      value={emptyRichDocument()}
      onChange={vi.fn()}
      noteId={CURRENT}
      links={{ listTargets: vi.fn().mockResolvedValue([
        target(CURRENT, '当前文档'),
        target('019c0000-0000-7000-8000-000000000002', '认证流程'),
        target('019c0000-0000-7000-8000-000000000003', '发布计划'),
      ]) }}
    />)
    await user.click(screen.getByRole('button', { name: '插入' }))
    await user.click(screen.getByRole('menuitem', { name: '内部链接' }))
    const search = await screen.findByRole('searchbox', { name: '筛选笔记' })
    expect(screen.queryByRole('treeitem', { name: '选择链接：当前文档' })).not.toBeInTheDocument()
    await user.type(search, '认证')
    expect(screen.getByRole('treeitem', { name: '选择链接：认证流程' })).toBeInTheDocument()
    expect(screen.queryByRole('treeitem', { name: '选择链接：发布计划' })).not.toBeInTheDocument()
  })
  it('collapses and expands folders in the shared picker', async () => {
    const user = userEvent.setup()
    const root = {
      id: '019c0000-0000-7000-8000-000000000010' as import('../../domain/model').FolderId,
      parentId: null,
      name: '课程',
      sortOrder: 0,
    }
    const child = {
      id: '019c0000-0000-7000-8000-000000000011' as import('../../domain/model').FolderId,
      parentId: root.id,
      name: '第一章',
      sortOrder: 0,
    }
    const childNote = {
      ...target('019c0000-0000-7000-8000-000000000012', '中心理解题'),
      folderId: child.id,
    }
    render(<RichDocumentEditor
      value={emptyRichDocument()}
      onChange={vi.fn()}
      noteId={CURRENT}
      folders={[root, child]}
      links={{ listTargets: vi.fn().mockResolvedValue([childNote]) }}
    />)

    await user.click(screen.getByRole('button', { name: '插入' }))
    await user.click(screen.getByRole('menuitem', { name: '内部链接' }))
    const dialog = await screen.findByRole('dialog', { name: '插入内部链接' })
    const tree = within(dialog).getByRole('tree', { name: '内部链接目标' })
    const rootFolder = within(tree).getByRole('treeitem', { name: '折叠文件夹：课程' })
    await user.click(rootFolder)
    expect(within(tree).queryByText('第一章')).not.toBeInTheDocument()
    await user.click(within(tree).getByRole('treeitem', { name: '展开文件夹：课程' }))
    expect(within(tree).getByText('第一章')).toBeVisible()
    expect(within(tree).getByRole('treeitem', { name: '选择链接：中心理解题' })).toBeVisible()
  })
})
