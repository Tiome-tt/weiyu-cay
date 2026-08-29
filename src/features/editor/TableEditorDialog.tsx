import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent } from 'react'
import { tableMarkdownFromCells, type MarkdownTableAlignment } from './markdownActions'

interface TableEditorDialogProps {
  initialRows: number
  initialColumns: number
  initialCells?: string[][]
  initialAlignments?: readonly MarkdownTableAlignment[]
  onCancel(): void
  onInsert(markdown: string): void
}

interface CellRange { startRow: number; startColumn: number; endRow: number; endColumn: number }

const minimumRows = 2
const minimumColumns = 1

function createCells(rows: number, columns: number) {
  return Array.from({ length: Math.max(minimumRows, rows) }, (_, row) =>
    Array.from({ length: Math.max(minimumColumns, columns) }, (_, column) => row === 0 ? `列 ${column + 1}` : ''),
  )
}

function clampCount(value: number, minimum: number) {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(99, Math.round(value))) : minimum
}

function isInRange(range: CellRange | null, row: number, column: number) {
  if (range === null) return false
  return row >= Math.min(range.startRow, range.endRow) && row <= Math.max(range.startRow, range.endRow)
    && column >= Math.min(range.startColumn, range.endColumn) && column <= Math.max(range.startColumn, range.endColumn)
}

function selectionEdge(range: CellRange | null, row: number, column: number) {
  if (!isInRange(range, row, column) || range === null) return undefined
  const top = Math.min(range.startRow, range.endRow)
  const bottom = Math.max(range.startRow, range.endRow)
  const left = Math.min(range.startColumn, range.endColumn)
  const right = Math.max(range.startColumn, range.endColumn)
  if (top === bottom && left === right) return undefined
  return [row === top ? 'top' : '', row === bottom ? 'bottom' : '', column === left ? 'left' : '', column === right ? 'right' : ''].filter(Boolean).join(' ')
}

function isSelectionAnchor(range: CellRange | null, row: number, column: number) {
  return range !== null && range.startRow === row && range.startColumn === column && (range.startRow !== range.endRow || range.startColumn !== range.endColumn)
}

function parsePastedCells(value: string) {
  return value.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map((row) => row.split('\t'))
}

export function TableEditorDialog({
  initialRows,
  initialColumns,
  initialCells,
  initialAlignments = [],
  onCancel,
  onInsert,
}: TableEditorDialogProps) {
  const editingExisting = initialCells !== undefined
  const [cells, setCells] = useState(() => initialCells?.map((row) => [...row]) ?? createCells(initialRows, initialColumns))
  const [selection, setSelection] = useState<CellRange | null>(null)
  const draggingRef = useRef(false)
  const boundaryKeyRef = useRef<{ row: number; column: number; key: 'ArrowLeft' | 'ArrowRight'; count: number } | null>(null)
  const gridRef = useRef<HTMLTableElement>(null)
  const historyRef = useRef<string[][][]>([])

  const recordHistory = () => {
    historyRef.current = [...historyRef.current.slice(-99), cells]
  }

  const setCell = (row: number, column: number, value: string) => setCells((current) => current.map((line, rowIndex) => rowIndex === row
    ? line.map((cell, columnIndex) => columnIndex === column ? value : cell) : line))

  const resize = (rows: number, columns: number) => {
    recordHistory()
    setCells((current) => Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => current[row]?.[column] ?? (row === 0 ? `列 ${column + 1}` : ''))))
    setSelection(null)
  }

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>, row: number, column: number) => {
    const value = event.clipboardData.getData('text/plain')
    if (!value.includes('\t') && !value.includes('\n')) return
    event.preventDefault()
    recordHistory()
    const pasted = parsePastedCells(value)
    const anchor = selection !== null && isInRange(selection, row, column)
      ? { row: Math.min(selection.startRow, selection.endRow), column: Math.min(selection.startColumn, selection.endColumn) }
      : { row, column }
    const pastedColumns = Math.max(...pasted.map((line) => line.length))
    const rows = Math.max(cells.length, anchor.row + pasted.length)
    const columns = Math.max(cells[0]?.length ?? minimumColumns, anchor.column + pastedColumns)
    setCells((current) => Array.from({ length: rows }, (_, rowIndex) => Array.from({ length: columns }, (_, columnIndex) => pasted[rowIndex - anchor.row]?.[columnIndex - anchor.column] ?? current[rowIndex]?.[columnIndex] ?? (rowIndex === 0 ? `列 ${columnIndex + 1}` : ''))))
    setSelection({ startRow: anchor.row, startColumn: anchor.column, endRow: anchor.row + pasted.length - 1, endColumn: anchor.column + pastedColumns - 1 })
  }

  const startDrag = (row: number, column: number) => {
    draggingRef.current = true
    setSelection({ startRow: row, startColumn: column, endRow: row, endColumn: column })
  }

  const extendDrag = (row: number, column: number) => {
    if (draggingRef.current) setSelection((current) => current ? { ...current, endRow: row, endColumn: column } : current)
  }

  const cellFromTarget = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return null
    const cell = target.closest<HTMLTableCellElement>('td[data-row][data-column]')
    if (cell === null) return null
    return { cell, row: Number(cell.dataset.row), column: Number(cell.dataset.column) }
  }

  const cellFromPoint = (clientX: number, clientY: number) => {
    const grid = gridRef.current
    if (grid !== null) {
      for (const cell of grid.querySelectorAll<HTMLTableCellElement>('td[data-row][data-column]')) {
        const rect = cell.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0 && clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
          return { cell, row: Number(cell.dataset.row), column: Number(cell.dataset.column) }
        }
      }
    }
    const elementFromPoint = document.elementFromPoint
    return elementFromPoint === undefined ? null : cellFromTarget(elementFromPoint.call(document, clientX, clientY))
  }

  const handleGridMouseDown = (event: React.MouseEvent<HTMLTableElement>) => {
    if (event.button !== 0) return
    const target = cellFromTarget(event.target)
    if (target === null) return
    event.preventDefault()
    target.cell.querySelector('input')?.focus()
    startDrag(target.row, target.column)
  }

  useEffect(() => {
    const move = (event: globalThis.MouseEvent) => {
      if (!draggingRef.current) return
      const target = cellFromPoint(event.clientX, event.clientY) ?? cellFromTarget(event.target)
      if (target !== null) extendDrag(target.row, target.column)
    }
    const stop = () => { draggingRef.current = false }
    window.addEventListener('mousemove', move, true)
    window.addEventListener('mouseup', stop, true)
    return () => {
      window.removeEventListener('mousemove', move, true)
      window.removeEventListener('mouseup', stop, true)
    }
  })

  const undo = () => {
    const previous = historyRef.current.pop()
    if (previous === undefined) return
    setCells(previous)
    setSelection(null)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      undo()
    }
  }

  const moveCell = (row: number, column: number, caret: 'start' | 'end' = 'start') => {
    const input = gridRef.current?.querySelector<HTMLInputElement>(`td[data-row="${row}"][data-column="${column}"] input`)
    if (input === null || input === undefined) return
    input.focus()
    const position = caret === 'end' ? input.value.length : 0
    input.setSelectionRange(position, position)
  }

  const handleCellKeyDown = (event: React.KeyboardEvent<HTMLInputElement>, row: number, column: number) => {
    const vertical: Record<string, number> = { ArrowUp: row - 1, ArrowDown: row + 1 }
    const nextRow = vertical[event.key]
    if (nextRow !== undefined) {
      event.preventDefault()
      boundaryKeyRef.current = null
      moveCell(Math.max(0, Math.min(cells.length - 1, nextRow)), column)
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      boundaryKeyRef.current = null
      return
    }
    const input = event.currentTarget
    const atBoundary = event.key === 'ArrowLeft'
      ? input.selectionStart === 0 && input.selectionEnd === 0
      : input.selectionStart === input.value.length && input.selectionEnd === input.value.length
    if (!atBoundary) {
      boundaryKeyRef.current = null
      return
    }
    const previous = boundaryKeyRef.current
    const count = previous?.row === row && previous.column === column && previous.key === event.key ? previous.count + 1 : 1
    boundaryKeyRef.current = { row, column, key: event.key, count }
    if (count < 2) return
    event.preventDefault()
    boundaryKeyRef.current = null
    const nextColumn = event.key === 'ArrowLeft' ? column - 1 : column + 1
    if (nextColumn < 0 || nextColumn >= (cells[0]?.length ?? 1)) return
    moveCell(row, nextColumn, event.key === 'ArrowLeft' ? 'end' : 'start')
  }

  return (
    <div className="table-editor-dialog" role="dialog" aria-modal="true" aria-label="编辑表格" onPointerDown={(event) => event.stopPropagation()} onKeyDown={handleKeyDown}>
      <header><div><span className="library-pane__eyebrow">Markdown 表格</span><h3>{editingExisting ? '编辑表格' : '插入表格'}</h3></div><button type="button" aria-label="关闭表格编辑器" onClick={onCancel}>×</button></header>
      <div className="table-editor-dialog__toolbar">
        <label>行数<input aria-label="表格行数" type="number" min={minimumRows} max={99} value={cells.length} onChange={(event) => resize(clampCount(Number(event.target.value), minimumRows), cells[0]?.length ?? minimumColumns)} /></label>
        <label>列数<input aria-label="表格列数" type="number" min={minimumColumns} max={99} value={cells[0]?.length ?? minimumColumns} onChange={(event) => resize(cells.length, clampCount(Number(event.target.value), minimumColumns))} /></label>
      </div>
        <div className="table-editor-dialog__grid-wrap" onWheel={(event) => event.stopPropagation()}>
        <table ref={gridRef} className="table-editor-dialog__grid" style={{ width: `${(cells[0]?.length ?? minimumColumns) * 120}px` }} onMouseDown={handleGridMouseDown}><tbody>{cells.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column} data-row={rowIndex} data-column={column} className={rowIndex === 0 ? 'table-editor-dialog__header-cell' : undefined} aria-selected={isInRange(selection, rowIndex, column)} data-selection-edge={selectionEdge(selection, rowIndex, column)} data-selection-anchor={isSelectionAnchor(selection, rowIndex, column) ? 'true' : undefined} onMouseEnter={() => extendDrag(rowIndex, column)} onMouseMove={() => extendDrag(rowIndex, column)}><input aria-label={`${rowIndex + 1} 行 ${column + 1} 列`} value={cell} onChange={(event) => { recordHistory(); setCell(rowIndex, column, event.target.value) }} onKeyDown={(event) => handleCellKeyDown(event, rowIndex, column)} onPaste={(event) => handlePaste(event, rowIndex, column)} /></td>)}</tr>)}</tbody></table>
      </div>
      <footer><button type="button" onClick={onCancel}>取消</button><button type="button" className="table-editor-dialog__primary" onClick={() => onInsert(tableMarkdownFromCells(cells, initialAlignments))}>{editingExisting ? '保存表格' : '插入表格'}</button></footer>
    </div>
  )
}
