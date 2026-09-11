import type { Editor } from '@tiptap/core'
import { Fragment } from '@tiptap/pm/model'
import { parseTsv, tsvTableContent } from './schema'

interface CellLocation {
  row: number
  column: number
  position: number
  nodeSize: number
}

function cellLocations(editor: Editor): { cells: CellLocation[]; startRow: number; startColumn: number } | undefined {
  const { $from } = editor.state.selection
  let tableDepth = -1
  let cellDepth = -1
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name
    if (cellDepth < 0 && (name === 'tableCell' || name === 'tableHeader')) cellDepth = depth
    if (name === 'table') { tableDepth = depth; break }
  }
  if (tableDepth < 0 || cellDepth < 0) return undefined

  const table = $from.node(tableDepth)
  const tablePosition = $from.before(tableDepth)
  const selectedCellPosition = $from.before(cellDepth)
  const cells: CellLocation[] = []
  let row = -1
  table.forEach((rowNode, rowOffset) => {
    row += 1
    let column = 0
    rowNode.forEach((cellNode, cellOffset) => {
      const position = tablePosition + 2 + rowOffset + cellOffset
      cells.push({ row, column, position, nodeSize: cellNode.nodeSize })
      const colspan = typeof cellNode.attrs.colspan === 'number' ? cellNode.attrs.colspan : 1
      column += colspan
    })
  })
  const selected = cells.find((cell) => cell.position === selectedCellPosition)
  return selected ? { cells, startRow: selected.row, startColumn: selected.column } : undefined
}

function cellBlocks(editor: Editor, value: string): Fragment {
  const paragraph = editor.state.schema.nodes.paragraph
  if (!paragraph) throw new Error('Rich editor schema requires paragraph nodes')
  return Fragment.fromArray(value.split('\n').map((line) => paragraph.create(null, line ? editor.state.schema.text(line) : undefined)))
}

/** Replace existing table cells in one transaction; never creates a nested table. */
export function pasteTsvAtSelection(editor: Editor, source: string): boolean {
  const rows = parseTsv(source)
  if (rows.length === 0 || rows.every((row) => row.length < 2)) return false
  const context = cellLocations(editor)
  if (!context) return editor.commands.insertContent(tsvTableContent(rows))

  const available = new Set(context.cells.map((cell) => `${cell.row}:${cell.column}`))
  const fits = rows.every((values, row) => values.every((_value, column) =>
    available.has(`${context.startRow + row}:${context.startColumn + column}`),
  ))
  if (!fits) return false

  const targets = context.cells
    .map((cell) => ({ cell, value: rows[cell.row - context.startRow]?.[cell.column - context.startColumn] }))
    .filter((target): target is { cell: CellLocation; value: string } => target.value !== undefined)
    .sort((left, right) => right.cell.position - left.cell.position)
  if (targets.length === 0) return false

  const transaction = editor.state.tr
  for (const { cell, value } of targets) {
    transaction.replaceWith(cell.position + 1, cell.position + cell.nodeSize - 1, cellBlocks(editor, value))
  }
  transaction.setMeta('uiEvent', 'paste').scrollIntoView()
  editor.view.dispatch(transaction)
  return true
}
