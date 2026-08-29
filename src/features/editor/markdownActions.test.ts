import { describe, expect, it } from 'vitest'
import {
  formatMarkdownSelection,
  markdownSnippets,
  parseMarkdownTable,
  tableMarkdown,
  tableMarkdownFromCells,
  tableMarkdownFromModel,
  tableWithCell,
  tableWithInsertedColumn,
  tableWithInsertedRow,
  tableWithAlignment,
  mergeTableCells,
  splitTableCell,
} from './markdownActions'

describe('markdown insertion actions', () => {
  it('creates a valid GFM table template', () => {
    expect(tableMarkdown(3, 2)).toBe('| 列 1 | 列 2 |\n| --- | --- |\n| 内容 1-1 | 内容 1-2 |\n| 内容 2-1 | 内容 2-2 |')
  })

  it('keeps common insertion snippets stable', () => {
    expect(markdownSnippets.link).toContain('https://')
    expect(markdownSnippets.task).toBe('- [ ] 待办事项')
  })

  it('parses cells and alignments from an existing GFM table', () => {
    const source = '| Name | Note |\n| :--- | ---: |\n| A\\|B | C\\\\D |'
    expect(parseMarkdownTable(source)).toEqual({
      cells: [['Name', 'Note'], ['A|B', 'C\\D']],
      alignments: ['left', 'right'],
    })
  })

  it('serializes edited cells while preserving alignment and escaping', () => {
    expect(tableMarkdownFromCells(
      [['Name', 'Note'], ['A|B', 'C\\D']],
      ['left', 'right'],
    )).toBe('| Name | Note |\n| :--- | ---: |\n| A\\|B | C\\\\D |')
  })

  it('rejects a malformed table separator', () => {
    expect(parseMarkdownTable('| A | B |\n| not a separator |')).toBeNull()
  })

  it('round-trips validated Cay merge metadata next to a GFM table', () => {
    const table = {
      cells: [['A', 'B', 'C'], ['1', '2', '3']],
      alignments: [null, 'center', 'right'] as const,
      merges: [{ row: 0, column: 0, rowSpan: 1, columnSpan: 2 }],
    }
    const markdown = tableMarkdownFromModel(table)
    expect(markdown).toContain('<!-- cay-table:')
    expect(parseMarkdownTable(markdown)).toEqual(table)
  })

  it('falls back to an ordinary table for malformed Cay metadata', () => {
    expect(parseMarkdownTable('| A | B |\n| --- | --- |\n| 1 | 2 |\n<!-- cay-table: {"merges":[{"row":0,"column":0,"rowSpan":9,"columnSpan":9}]} -->')).toEqual({
      cells: [['A', 'B'], ['1', '2']],
      alignments: [null, null],
    })
  })

  it('edits cells and expands a table with inserted rows and columns', () => {
    const table = parseMarkdownTable('| A | B |\n| --- | --- |\n| 1 | 2 |')
    if (table === null) throw new Error('expected table')
    const edited = tableWithCell(table, 1, 1, 'updated')
    expect(tableWithInsertedRow(tableWithInsertedColumn(edited, 2), 2).cells).toEqual([
      ['A', 'B', ''],
      ['1', 'updated', ''],
      ['', '', ''],
    ])
  })

  it('changes a selected column alignment without changing cell content', () => {
    const table = parseMarkdownTable('| A | B |\n| --- | --- |\n| 1 | 2 |')
    if (table === null) throw new Error('expected table')
    expect(tableWithAlignment(table, 1, 'center')).toEqual({
      cells: [['A', 'B'], ['1', '2']],
      alignments: [null, 'center'],
    })
  })

  it('merges and splits a rectangular selection without losing cell text', () => {
    const table = {
      cells: [['A', 'B'], ['1', '2']],
      alignments: [null, null] as const,
    }
    const merged = mergeTableCells(table, { startRow: 0, startColumn: 0, endRow: 1, endColumn: 1 })
    expect(merged.merges).toEqual([{ row: 0, column: 0, rowSpan: 2, columnSpan: 2 }])
    expect(merged.cells).toEqual([['A', 'B'], ['1', '2']])
    expect(splitTableCell(merged, 0, 0)).toEqual({ ...table, merges: [] })
  })
})

describe('Markdown selection formatting', () => {
  it.each([
    ['bold', '**海风**', 3, 5],
    ['italic', '*海风*', 2, 4],
    ['link', '[海风](https://)', 2, 4],
    ['code', '`海风`', 2, 4],
    ['strikethrough', '~~海风~~', 3, 5],
  ] as const)('wraps only the selected text as %s', (style, markdown, from, to) => {
    expect(formatMarkdownSelection('听海风经过', 1, 3, style)).toEqual({
      markdown: `听${markdown}经过`,
      from,
      to,
    })
  })

  it('does not invent Markdown for a collapsed selection', () => {
    expect(formatMarkdownSelection('潮汐', 1, 1, 'bold')).toEqual({
      markdown: '潮汐',
      from: 1,
      to: 1,
    })
  })
})
