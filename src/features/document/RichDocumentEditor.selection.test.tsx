import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { emptyRichDocument } from '../../domain/content'
import { RichDocumentEditor } from './RichDocumentEditor'

beforeAll(() => {
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.querySelector('.tiptap') })
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(0, 0, 10, 10) })
})
afterEach(cleanup)

describe('RichDocumentEditor table tools', () => {
  it('shows contextual table actions as soon as selection enters a table', async () => {
    render(<RichDocumentEditor value={emptyRichDocument()} onChange={vi.fn()} />)
    expect(screen.queryByRole('toolbar', { name: '表格工具' })).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: '插入' }))
    await userEvent.setup().click(screen.getByRole('menuitem', { name: '表格' }))
    await userEvent.setup().click(screen.getByRole('gridcell', { name: '3 行 3 列' }))
    expect(await screen.findByRole('toolbar', { name: '表格工具' })).toBeInTheDocument()
  })

  it('reveals a corner control that selects every cell in the hovered table', async () => {
    render(<RichDocumentEditor value={emptyRichDocument()} onChange={vi.fn()} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '插入' }))
    await user.click(screen.getByRole('menuitem', { name: '表格' }))
    await user.click(screen.getByRole('gridcell', { name: '2 行 2 列' }))

    const table = await screen.findByRole('table')
    expect(screen.queryByRole('button', { name: '选择整个表格' })).not.toBeInTheDocument()
    fireEvent.mouseMove(table)
    const selectAll = await screen.findByRole('button', { name: '选择整个表格' })
    expect(selectAll.querySelector('svg')).toBeInTheDocument()
    expect(selectAll).not.toHaveTextContent('＋')
    await user.click(selectAll)

    expect(table.querySelectorAll('.selectedCell')).toHaveLength(4)
  })
})
