import { describe, expect, it } from 'vitest'
import { applyMarkdownTableMerges, renderPreviewMarkdown } from './markdownPipeline'
import { tableMarkdownFromModel } from './markdownActions'

describe('markdown preview table enhancements', () => {
  it('applies validated Cay merge metadata to rendered preview tables', () => {
    const markdown = tableMarkdownFromModel({
      cells: [['A', 'B'], ['1', '2'], ['3', '4']],
      alignments: [null, null],
      merges: [{ row: 0, column: 0, rowSpan: 2, columnSpan: 2 }],
    })
    const host = document.createElement('div')
    host.innerHTML = renderPreviewMarkdown(markdown)

    applyMarkdownTableMerges(host, markdown)

    const table = host.querySelector('table')
    expect(table).not.toBeNull()
    expect(table?.querySelector('th')?.rowSpan).toBe(2)
    expect(table?.querySelector('th')?.colSpan).toBe(2)
    expect(table?.querySelectorAll('tr')[0]?.children).toHaveLength(1)
    expect(table?.querySelectorAll('tr')[1]?.children).toHaveLength(0)
  })

  it('leaves ordinary and malformed metadata tables unchanged', () => {
    const markdown = '| A | B |\n| --- | --- |\n| 1 | 2 |\n<!-- cay-table: {"merges":[{"row":0,"column":0,"rowSpan":9,"columnSpan":9}]} -->'
    const host = document.createElement('div')
    host.innerHTML = renderPreviewMarkdown(markdown)

    applyMarkdownTableMerges(host, markdown)

    expect(host.querySelectorAll('table tr')[0]?.children).toHaveLength(2)
    expect(host.querySelector('th')?.rowSpan).toBe(1)
  })
})
