import type { Editor } from '@tiptap/core'
import { Fragment } from '@tiptap/pm/model'
import { closeHistory } from '@tiptap/pm/history'
import { __insertCells, isInTable, selectedRect } from '@tiptap/pm/tables'
import { parseTsv, tsvTableContent } from './schema'

/** Replace a logical rectangle atomically, including spans and overflow. */
export function pasteTsvAtSelection(editor: Editor, source: string): boolean {
  const rows = parseTsv(source)
  if (!rows.length || rows.every(row => row.length < 2) && (!isInTable(editor.state) || rows.length < 2)) return false
  const content = tsvTableContent(rows)
  if (!isInTable(editor.state)) return editor.commands.insertContent(content)
  const table = editor.state.schema.nodeFromJSON(content)
  const rect = selectedRect(editor.state)
  const width = Math.max(...rows.map(row => row.length))
  const fragments: Fragment[] = []
  table.forEach(row => fragments.push(row.content))
  // The pinned table plugin handles expansion and intersecting spans in one
  // transaction. Keep regression coverage when upgrading this dependency.
  __insertCells(editor.state, transaction => editor.view.dispatch(closeHistory(transaction)), rect.tableStart,
    { ...rect, right: rect.left + width, bottom: rect.top + rows.length },
    { width, height: rows.length, rows: fragments })
  return true
}
