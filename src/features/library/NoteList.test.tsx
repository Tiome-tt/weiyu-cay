import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderId, NoteId } from '../../domain/model'
import { note } from '../../test/fakes'
import { NoteList, reorderNoteIds } from './NoteList'

afterEach(cleanup)
describe('reorderNoteIds', () => {
  const ids = ['a', 'b', 'c', 'd'] as NoteId[]
  it('inserts before or after the target according to the drop half', () => {
    expect(reorderNoteIds(ids, 'a' as NoteId, 'c' as NoteId, 'before')).toEqual(['b', 'a', 'c', 'd'])
    expect(reorderNoteIds(ids, 'a' as NoteId, 'c' as NoteId, 'after')).toEqual(['b', 'c', 'a', 'd'])
  })
  it('returns the original order for a self drop or missing target', () => {
    expect(reorderNoteIds(ids, 'b' as NoteId, 'b' as NoteId, 'after')).toEqual(ids)
    expect(reorderNoteIds(ids, 'b' as NoteId, 'missing' as NoteId, 'before')).toEqual(ids)
  })
})
const entry = { ...note(), excerpt: '' }

it('shows Markdown notes without repeating the MD extension', () => {
  render(<NoteList notes={[entry]} activeId={null} state="ready" onSelect={vi.fn()} />)
  const card = screen.getByRole('button', { name: entry.title })
  expect(within(card).getByText('Markdown')).toBeVisible()
  expect(within(card).queryByText('Markdown · MD')).not.toBeInTheDocument()
})


it('keeps hover rows free of delete controls and exposes deletion through the context menu', () => {
  const onDelete = vi.fn()
  render(<NoteList notes={[entry]} activeId={entry.id} state="ready" onSelect={vi.fn()} onDelete={onDelete} />)
  const card = screen.getByRole('button', { name: entry.title })
  fireEvent.mouseOver(card)
  expect(screen.queryByRole('button', { name: `删除 ${entry.title}` })).not.toBeInTheDocument()
  fireEvent.contextMenu(card)
  fireEvent.click(screen.getByRole('menuitem', { name: '删除笔记' }))
  expect(onDelete).toHaveBeenCalledWith(entry.id, entry.title)
})

it('supports keyboard context menus and prevents a second deletion while busy', () => {
  render(<NoteList notes={[entry]} activeId={entry.id} state="ready" onSelect={vi.fn()} onDelete={vi.fn()} deletingId={entry.id} />)
  const card = screen.getByRole('button', { name: entry.title })
  card.focus()
  fireEvent.keyDown(card, { key: 'F10', shiftKey: true })
  expect(screen.getByRole('menuitem', { name: '删除笔记' })).toBeDisabled()
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(card).toHaveFocus()
})

it('shows undo feedback outside the note list without removing its accessible actions', () => {
  const undo = vi.fn()
  const dismiss = vi.fn()
  render(<NoteList notes={[entry]} activeId={null} state="ready" onSelect={vi.fn()} deleteFeedback="笔记已移入回收站。" undoAvailable onUndoDelete={undo} onDismissFeedback={dismiss} />)
  expect(within(screen.getByRole('region', { name: '笔记列表' })).queryByRole('status')).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('笔记已移入回收站。')
  fireEvent.click(screen.getByRole('button', { name: '撤销删除' }))
  fireEvent.click(screen.getByRole('button', { name: '关闭提示' }))
  expect(undo).toHaveBeenCalledOnce()
  expect(dismiss).toHaveBeenCalledOnce()
})
it('identifies mixed library entries and exposes the original file extension', () => {
 const documentEntry={...entry,id:'019c0000-0000-7000-8000-000000000211' as typeof entry.id,title:'方案',content:{type:'document' as const,document:{schemaVersion:1 as const,root:{type:'doc'}}}}
 const officeEntry={...entry,id:'019c0000-0000-7000-8000-000000000212' as typeof entry.id,title:'预算',content:{type:'file' as const,file:{storageName:'payload',originalName:'预算.final.xlsx',mediaType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',size:12,sha256:'abc'}}}
 render(<NoteList notes={[documentEntry,officeEntry]} activeId={null} state="ready" onSelect={vi.fn()}/>)
 expect(screen.getByRole('button',{name:'方案'})).toHaveAccessibleDescription('文档')
 expect(within(screen.getByRole('button',{name:'预算'})).getByText('Office · XLSX')).toBeVisible()
 expect(screen.getByRole('button',{name:'预算'})).toHaveAccessibleDescription('Office · XLSX')
})

it('does not offer PDF export for non-PDF attachments', () => {
  const officeEntry = {
    ...entry,
    id: '019c0000-0000-7000-8000-000000000213' as NoteId,
    content: {
      type: 'file' as const,
      file: {
        storageName: 'payload',
        originalName: '预算.xlsx',
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 12,
        sha256: 'abc',
      },
    },
  }
  render(<NoteList notes={[officeEntry]} activeId={null} state="ready" onSelect={vi.fn()} onExport={vi.fn()} />)
  fireEvent.contextMenu(screen.getByRole('button', { name: entry.title }))
  expect(screen.queryByRole('menuitem', { name: '导出 PDF' })).not.toBeInTheDocument()
  expect(screen.queryByRole('menuitem', { name: '另存 PDF' })).not.toBeInTheDocument()
})
it('supports keyboard multi-selection and moves or deletes the selected set', () => {
  const second = {
    ...entry,
    id: '019c0000-0000-7000-8000-000000000221' as NoteId,
    title: '第二项',
  }
  const targetFolder = '019c0000-0000-7000-8000-000000000222' as FolderId
  const onDeleteSelection = vi.fn()
  const onMoveSelection = vi.fn().mockResolvedValue(undefined)
  render(<NoteList
    notes={[entry, second]}
    activeId={null}
    state="ready"
    onSelect={vi.fn()}
    onDeleteSelection={onDeleteSelection}
    onMoveSelection={onMoveSelection}
    folders={[{ id: targetFolder, parentId: null, name: '归档', sortOrder: 0 }]}
  />)

  const firstCard = screen.getByRole('button', { name: entry.title })
  const secondCard = screen.getByRole('button', { name: second.title })
  fireEvent.keyDown(firstCard, { key: ' ', ctrlKey: true })
  fireEvent.keyDown(secondCard, { key: ' ', ctrlKey: true })
  expect(firstCard).toHaveAttribute('aria-pressed', 'true')
  expect(secondCard).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('status')).toHaveTextContent('已选择 2 项')

  fireEvent.contextMenu(secondCard)
  expect(screen.queryByRole('menuitem', { name: '移动 2 项' })).not.toBeInTheDocument()
  fireEvent.change(screen.getByRole('combobox', { name: '移动所选条目到' }), { target: { value: targetFolder } })
  fireEvent.submit(screen.getByRole('form', { name: '移动所选条目' }))
  expect(onMoveSelection).toHaveBeenCalledWith([entry.id, second.id], targetFolder)

  fireEvent.contextMenu(secondCard)
  fireEvent.click(screen.getByRole('menuitem', { name: '删除 2 项' }))
  expect(onDeleteSelection).toHaveBeenCalledWith([entry, second])
})


it('reorders by the pointer drop half and exposes a visible drop marker', async () => {
  const second = { ...entry, id: '019c0000-0000-7000-8000-000000000223' as NoteId, title: '第二项' }
  const onReorder = vi.fn().mockResolvedValue(undefined)
  render(<NoteList notes={[entry, second]} activeId={null} state="ready" onSelect={vi.fn()} onReorder={onReorder} />)
  const firstCard = screen.getByRole('button', { name: entry.title })
  const secondRow = screen.getByRole('button', { name: second.title }).closest('[data-note-id]') as HTMLElement
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => secondRow) })
  vi.spyOn(secondRow, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 40, bottom: 40 } as DOMRect)
  fireEvent.pointerDown(firstCard, { button: 0, clientX: 10, clientY: 5 })
  fireEvent.pointerMove(window, { clientX: 10, clientY: 30 })
  expect(secondRow).toHaveClass('note-list__row--drop-after')
  fireEvent.pointerUp(window, { clientX: 10, clientY: 30 })
  await waitFor(() => expect(onReorder).toHaveBeenCalledWith(null, [second.id, entry.id]))
  vi.restoreAllMocks()
})
