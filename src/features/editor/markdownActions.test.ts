import { describe, expect, it } from 'vitest'
import { markdownSnippets, tableMarkdown, tableMarkdownFromCells } from './markdownActions'

describe('markdown insertion actions', () => {
  it('creates a valid GFM table template', () => {
    expect(tableMarkdown(3, 2)).toBe('| 列 1 | 列 2 |\n| --- | --- |\n| 内容 1-1 | 内容 1-2 |\n| 内容 2-1 | 内容 2-2 |')
  })

  it('keeps common insertion snippets stable', () => {
    expect(markdownSnippets.link).toContain('https://')
    expect(markdownSnippets.task).toBe('- [ ] 待办事项')
  })

  it('escapes table cell delimiters without changing cell content', () => {
    expect(tableMarkdownFromCells([['A | B'], [String.raw`C\D`]])).toBe(String.raw`| A \| B |
| --- |
| C\\D |`)
  })
})
