import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
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
    const search = await screen.findByRole('searchbox', { name: '搜索文档' })
    expect(screen.queryByRole('button', { name: '当前文档' })).not.toBeInTheDocument()
    await user.type(search, '认证')
    expect(screen.getByRole('button', { name: '认证流程' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '发布计划' })).not.toBeInTheDocument()
  })
})
