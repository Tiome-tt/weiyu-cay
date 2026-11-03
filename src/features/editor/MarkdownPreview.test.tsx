import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MarkdownPreview } from './MarkdownPreview'
afterEach(cleanup)
it('places preview tables in a scrollable container while preserving header cells', () => {
  render(<MarkdownPreview markdown={'| 名称 | 值 |\n| --- | --- |\n| 正文 | 1 |'}/>)
  const table = screen.getByRole('table')
  expect(table.parentElement).toHaveClass('markdown-table-viewport')
  expect(screen.getByRole('columnheader', {name:'名称'})).toBeInTheDocument()
  expect(screen.getByRole('cell', {name:'正文'})).toBeInTheDocument()
})
