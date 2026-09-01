import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { note } from '../../test/fakes'
import { NoteList } from './NoteList'

afterEach(cleanup)
const entry = { ...note(), excerpt: '' }

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
