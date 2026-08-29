export function tableMarkdown(rows = 3, columns = 3) {
  return tableMarkdownFromCells(Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => row === 0 ? `列 ${column + 1}` : `内容 ${row}-${column + 1}`)))
}

export type MarkdownTableAlignment = 'left' | 'center' | 'right' | null

export interface MarkdownTableMerge {
  row: number
  column: number
  rowSpan: number
  columnSpan: number
}

export interface MarkdownTable {
  cells: string[][]
  alignments: readonly MarkdownTableAlignment[]
  merges?: MarkdownTableMerge[]
}

export interface TableCellRange {
  startRow: number
  startColumn: number
  endRow: number
  endColumn: number
}

export function tableMarkdownFromCells(
  cells: string[][],
  alignments: readonly MarkdownTableAlignment[] = [],
) {
  const normalized = cells.length === 0 ? [['']] : cells
  const columns = Math.max(1, ...normalized.map((row) => row.length))
  const header = Array.from({ length: columns }, (_, column) => normalized[0]?.[column]?.trim() || `列 ${column + 1}`)
  const divider = header.map((_, column) => alignmentMarker(alignments[column] ?? null))
  const body = normalized.slice(1).map((row) => Array.from({ length: columns }, (_, column) => row[column]?.trim() ?? ''))
  return [formatRow(header), formatRow(divider, false), ...body.map((row) => formatRow(row))].join('\n')
}

export function parseMarkdownTable(source: string): MarkdownTable | null {
  const normalized = source.replace(/\r\n?/gu, '\n')
  const metadata = parseTableMetadata(normalized)
  const lines = normalized.split('\n').filter((line) => !isTableMetadataLine(line))
  if (lines.length < 2) return null
  const header = parseTableRow(lines[0])
  const separators = parseTableRow(lines[1])
  if (header.length === 0 || separators.length !== header.length) return null
  const alignments = separators.map(parseAlignment)
  if (alignments.some((alignment) => alignment === undefined)) return null
  const cells = [header]
  for (const line of lines.slice(2)) {
    const row = parseTableRow(line)
    cells.push(Array.from({ length: header.length }, (_, column) => row[column] ?? ''))
  }
  const merges = metadata === undefined || metadata === null ? undefined : normalizeMerges(metadata, cells.length, header.length) ?? undefined
  return merges === undefined ? { cells, alignments: alignments as MarkdownTableAlignment[] } : { cells, alignments: alignments as MarkdownTableAlignment[], merges }
}

export function tableMarkdownFromModel(table: MarkdownTable) {
  const markdown = tableMarkdownFromCells(table.cells, table.alignments)
  const merges = normalizeMerges(table.merges ?? [], table.cells.length, Math.max(1, ...table.cells.map((row) => row.length))) ?? []
  return merges.length === 0
    ? markdown
    : `${markdown}\n<!-- cay-table: ${JSON.stringify({ merges })} -->`
}

export function tableWithCell(table: MarkdownTable, row: number, column: number, value: string): MarkdownTable {
  if (!isCellInside(table, row, column)) return cloneTable(table)
  const anchor = mergeAnchorAt(table.merges ?? [], row, column) ?? { row, column }
  const cells = cloneCells(table.cells)
  cells[anchor.row]![anchor.column] = value
  return { ...cloneTable(table), cells }
}

export function tableWithAlignment(
  table: MarkdownTable,
  column: number,
  alignment: MarkdownTableAlignment,
): MarkdownTable {
  const columns = Math.max(1, ...table.cells.map((row) => row.length))
  if (column < 0 || column >= columns) return cloneTable(table)
  const alignments = Array.from({ length: columns }, (_, index) => table.alignments[index] ?? null)
  alignments[column] = alignment
  return { ...cloneTable(table), alignments }
}

export function tableWithInsertedRow(table: MarkdownTable, row: number): MarkdownTable {
  const cells = cloneCells(table.cells)
  const index = Math.max(0, Math.min(cells.length, Math.round(row)))
  const columns = Math.max(1, ...cells.map((line) => line.length))
  cells.splice(index, 0, Array.from({ length: columns }, () => ''))
  const merges = adjustMergesForInsertedRow(table.merges ?? [], index)
  return { ...cloneTable(table), cells, merges }
}

export function tableWithInsertedColumn(table: MarkdownTable, column: number): MarkdownTable {
  const cells = cloneCells(table.cells)
  const index = Math.max(0, Math.min(Math.max(1, ...cells.map((line) => line.length)), Math.round(column)))
  for (const line of cells) line.splice(index, 0, '')
  const merges = adjustMergesForInsertedColumn(table.merges ?? [], index)
  return { ...cloneTable(table), cells, merges }
}

export function tableWithDeletedRow(table: MarkdownTable, row: number): MarkdownTable {
  if (table.cells.length <= 2 || row < 0 || row >= table.cells.length) return cloneTable(table)
  const cells = cloneCells(table.cells)
  cells.splice(row, 1)
  return { ...cloneTable(table), cells, merges: adjustMergesForDeletedRow(table.merges ?? [], row) }
}

export function tableWithDeletedColumn(table: MarkdownTable, column: number): MarkdownTable {
  const columns = Math.max(1, ...table.cells.map((line) => line.length))
  if (columns <= 1 || column < 0 || column >= columns) return cloneTable(table)
  const cells = cloneCells(table.cells)
  for (const line of cells) line.splice(column, 1)
  return { ...cloneTable(table), cells, merges: adjustMergesForDeletedColumn(table.merges ?? [], column) }
}

export function mergeTableCells(table: MarkdownTable, range: TableCellRange): MarkdownTable {
  const normalized = normalizeRange(range, table.cells.length, Math.max(1, ...table.cells.map((line) => line.length)))
  if (normalized === null) return cloneTable(table)
  const merges = table.merges ?? []
  if (merges.some((merge) => rangesOverlap(merge, normalized))) return cloneTable(table)
  const cells = cloneCells(table.cells)
  return {
    ...cloneTable(table),
    cells,
    merges: [...merges, {
      row: normalized.startRow,
      column: normalized.startColumn,
      rowSpan: normalized.endRow - normalized.startRow + 1,
      columnSpan: normalized.endColumn - normalized.startColumn + 1,
    }],
  }
}

export function splitTableCell(table: MarkdownTable, row: number, column: number): MarkdownTable {
  const merge = mergeAt(table.merges ?? [], row, column)
  if (merge === undefined) return cloneTable(table)
  return { ...cloneTable(table), merges: (table.merges ?? []).filter((candidate) => candidate !== merge) }
}

function parseTableMetadata(source: string): unknown[] | null | undefined {
  const lines = source.split('\n')
  const line = [...lines].reverse().find((candidate: string) => isTableMetadataLine(candidate))
  if (line === undefined) return undefined
  const match = /^\s*<!--\s*cay-table:\s*(\{.*\})\s*-->\s*$/u.exec(line)
  if (match === null) return null
  try {
    const value: unknown = JSON.parse(match[1])
    if (!isRecord(value) || !Array.isArray(value.merges)) return null
    return value.merges
  } catch {
    return null
  }
}

export function isTableMetadataLine(line: string) {
  return /^\s*<!--\s*cay-table:/u.test(line)
}

function normalizeMerges(value: unknown, rows: number, columns: number): MarkdownTableMerge[] | null {
  if (!Array.isArray(value)) return null
  const merges: MarkdownTableMerge[] = []
  for (const candidate of value) {
    if (!isRecord(candidate)) return null
    const row = integer(candidate.row)
    const column = integer(candidate.column)
    const rowSpan = integer(candidate.rowSpan)
    const columnSpan = integer(candidate.columnSpan)
    if (row === null || column === null || rowSpan === null || columnSpan === null || row < 0 || column < 0 || rowSpan < 1 || columnSpan < 1) return null
    const merge = { row, column, rowSpan, columnSpan }
    if (row + rowSpan > rows || column + columnSpan > columns || merges.some((existing) => rangesOverlap(existing, merge))) return null
    merges.push(merge)
  }
  return merges
}

function integer(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneCells(cells: string[][]) {
  return cells.map((row) => [...row])
}

function cloneTable(table: MarkdownTable): MarkdownTable {
  return {
    cells: cloneCells(table.cells),
    alignments: [...table.alignments],
    ...(table.merges === undefined ? {} : { merges: table.merges.map((merge) => ({ ...merge })) }),
  }
}

function isCellInside(table: MarkdownTable, row: number, column: number) {
  return row >= 0 && row < table.cells.length && column >= 0 && column < (table.cells[row]?.length ?? 0)
}

function mergeAnchorAt(merges: readonly MarkdownTableMerge[], row: number, column: number) {
  const merge = mergeAt(merges, row, column)
  return merge === undefined ? undefined : { row: merge.row, column: merge.column }
}

function mergeAt(merges: readonly MarkdownTableMerge[], row: number, column: number) {
  return merges.find((merge) => row >= merge.row && row < merge.row + merge.rowSpan && column >= merge.column && column < merge.column + merge.columnSpan)
}

function normalizeRange(range: TableCellRange, rows: number, columns: number) {
  const startRow = Math.max(0, Math.min(rows - 1, Math.min(range.startRow, range.endRow)))
  const endRow = Math.max(0, Math.min(rows - 1, Math.max(range.startRow, range.endRow)))
  const startColumn = Math.max(0, Math.min(columns - 1, Math.min(range.startColumn, range.endColumn)))
  const endColumn = Math.max(0, Math.min(columns - 1, Math.max(range.startColumn, range.endColumn)))
  return rows > 0 && columns > 0 ? { startRow, endRow, startColumn, endColumn } : null
}

function rangesOverlap(left: MarkdownTableMerge | TableCellRange, right: MarkdownTableMerge | TableCellRange) {
  const leftRow = 'row' in left ? left.row : left.startRow
  const leftColumn = 'column' in left ? left.column : left.startColumn
  const leftBottom = 'rowSpan' in left ? left.row + left.rowSpan - 1 : left.endRow
  const leftRight = 'columnSpan' in left ? left.column + left.columnSpan - 1 : left.endColumn
  const rightRow = 'row' in right ? right.row : right.startRow
  const rightColumn = 'column' in right ? right.column : right.startColumn
  const rightBottom = 'rowSpan' in right ? right.row + right.rowSpan - 1 : right.endRow
  const rightRight = 'columnSpan' in right ? right.column + right.columnSpan - 1 : right.endColumn
  return leftRow <= rightBottom && rightRow <= leftBottom && leftColumn <= rightRight && rightColumn <= leftRight
}

function adjustMergesForInsertedRow(merges: readonly MarkdownTableMerge[], row: number) {
  return merges.map((merge) => {
    if (row <= merge.row) return { ...merge, row: merge.row + 1 }
    if (row < merge.row + merge.rowSpan) return { ...merge, rowSpan: merge.rowSpan + 1 }
    return { ...merge }
  })
}

function adjustMergesForInsertedColumn(merges: readonly MarkdownTableMerge[], column: number) {
  return merges.map((merge) => {
    if (column <= merge.column) return { ...merge, column: merge.column + 1 }
    if (column < merge.column + merge.columnSpan) return { ...merge, columnSpan: merge.columnSpan + 1 }
    return { ...merge }
  })
}

function adjustMergesForDeletedRow(merges: readonly MarkdownTableMerge[], row: number) {
  return merges.flatMap((merge) => {
    if (row < merge.row) return [{ ...merge, row: merge.row - 1 }]
    if (row >= merge.row + merge.rowSpan) return [{ ...merge }]
    if (merge.rowSpan <= 1) return []
    if (row === merge.row) return [{ ...merge, row: merge.row, rowSpan: merge.rowSpan - 1 }]
    return [{ ...merge, rowSpan: merge.rowSpan - 1 }]
  })
}

function adjustMergesForDeletedColumn(merges: readonly MarkdownTableMerge[], column: number) {
  return merges.flatMap((merge) => {
    if (column < merge.column) return [{ ...merge, column: merge.column - 1 }]
    if (column >= merge.column + merge.columnSpan) return [{ ...merge }]
    if (merge.columnSpan <= 1) return []
    if (column === merge.column) return [{ ...merge, column: merge.column, columnSpan: merge.columnSpan - 1 }]
    return [{ ...merge, columnSpan: merge.columnSpan - 1 }]
  })
}

export function formatRow(cells: string[], escape = true) {
  const formatted = escape ? cells.map(escapeTableCell) : cells
  return `| ${formatted.join(' | ')} |`
}

function parseTableRow(line: string) {
  let value = line.trim()
  if (value.startsWith('|')) value = value.slice(1)
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === '\\' && index + 1 < value.length && (value[index + 1] === '|' || value[index + 1] === '\\')) {
      cell += value[index + 1]
      index += 1
    } else if (character === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += character
    }
  }
  cells.push(cell.trim())
  return cells
}

function parseAlignment(value: string): MarkdownTableAlignment | undefined {
  if (!/^:?-+:?$/u.test(value)) return undefined
  if (value.startsWith(':') && value.endsWith(':')) return 'center'
  if (value.startsWith(':')) return 'left'
  if (value.endsWith(':')) return 'right'
  return null
}

function alignmentMarker(alignment: MarkdownTableAlignment) {
  if (alignment === 'left') return ':---'
  if (alignment === 'center') return ':---:'
  if (alignment === 'right') return '---:'
  return '---'
}

function escapeTableCell(value: string) {
  return value.replace(/\\/gu, '\\\\').replace(/\|/gu, '\\|')
}

export const markdownSnippets = {
  link: '[链接文字](https://example.com)',
  image: '![图片说明](图片地址)',
  code: '```\n代码内容\n```',
  quote: '> 引用内容',
  task: '- [ ] 待办事项',
  divider: '---',
} as const

export type MarkdownSelectionStyle = 'bold' | 'italic' | 'link' | 'code' | 'strikethrough'

export interface MarkdownSelectionResult {
  markdown: string
  from: number
  to: number
}

export function formatMarkdownSelection(
  markdown: string,
  from: number,
  to: number,
  style: MarkdownSelectionStyle,
): MarkdownSelectionResult {
  const start = Math.max(0, Math.min(from, markdown.length))
  const end = Math.max(start, Math.min(to, markdown.length))
  if (start === end) return { markdown, from: start, to: end }

  const selected = markdown.slice(start, end)
  const [prefix, suffix] = selectionAffixes(style)
  return {
    markdown: `${markdown.slice(0, start)}${prefix}${selected}${suffix}${markdown.slice(end)}`,
    from: start + prefix.length,
    to: end + prefix.length,
  }
}

function selectionAffixes(style: MarkdownSelectionStyle): readonly [string, string] {
  switch (style) {
    case 'bold': return ['**', '**']
    case 'italic': return ['*', '*']
    case 'link': return ['[', '](https://)']
    case 'code': return ['`', '`']
    case 'strikethrough': return ['~~', '~~']
  }
}
