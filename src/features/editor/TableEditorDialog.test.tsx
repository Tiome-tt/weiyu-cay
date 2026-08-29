import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TableEditorDialog } from './TableEditorDialog'

describe('TableEditorDialog', () => {
  afterEach(cleanup)
  it('edits cells and inserts the resulting GFM table', async () => {
    const user = userEvent.setup()
    const onInsert = vi.fn()
    render(<TableEditorDialog initialRows={2} initialColumns={2} onCancel={vi.fn()} onInsert={onInsert} />)
    await user.clear(screen.getByRole('textbox', { name: '2 行 1 列' }))
    await user.type(screen.getByRole('textbox', { name: '2 行 1 列' }), '内容')
    await user.click(screen.getByRole('button', { name: '插入表格' }))
    expect(onInsert).toHaveBeenCalledWith('| 列 1 | 列 2 |\n| --- | --- |\n| 内容 |  |')
  })

  it('loads and saves an existing aligned GFM table', async () => {
    const user = userEvent.setup()
    const onInsert = vi.fn()
    render(
      <TableEditorDialog
        initialRows={2}
        initialColumns={2}
        initialCells={[['Name', 'Note'], ['A', 'B']]}
        initialAlignments={['left', 'right']}
        onCancel={vi.fn()}
        onInsert={onInsert}
      />,
    )

    expect((screen.getByRole('textbox', { name: '1 行 1 列' }) as HTMLInputElement).value).toBe('Name')
    const cell = screen.getByRole('textbox', { name: '2 行 2 列' })
    await user.clear(cell)
    await user.type(cell, 'C')
    await user.click(screen.getByRole('button', { name: '保存表格' }))

    expect(onInsert).toHaveBeenCalledWith('| Name | Note |\n| :--- | ---: |\n| A | C |')
  })

  it('changes the table size with row and column inputs', () => {
    render(<TableEditorDialog initialRows={3} initialColumns={2} onCancel={vi.fn()} onInsert={vi.fn()} />)
    fireEvent.change(screen.getByRole('spinbutton', { name: '表格行数' }), { target: { value: '4' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '表格列数' }), { target: { value: '3' } })
    expect(screen.getAllByRole('textbox').filter((element) => element.getAttribute('aria-label')?.includes('列'))).toHaveLength(12)
  })

  it('pastes an Excel-style TSV range into the grid and selects it', () => {
    render(<TableEditorDialog initialRows={2} initialColumns={2} onCancel={vi.fn()} onInsert={vi.fn()} />)
    const target = screen.getByRole('textbox', { name: '2 行 2 列' })
    fireEvent.paste(target, { clipboardData: { getData: () => 'A\tB\nC\tD' } })
    expect((screen.getByRole('textbox', { name: '2 行 2 列' }) as HTMLInputElement).value).toBe('A')
    expect((screen.getByRole('textbox', { name: '3 行 3 列' }) as HTMLInputElement).value).toBe('D')
    expect(target.parentElement?.getAttribute('aria-selected')).toBe('true')
  })

  it('selects a range by dragging across cells', () => {
    render(<TableEditorDialog initialRows={3} initialColumns={3} onCancel={vi.fn()} onInsert={vi.fn()} />)
    const start = screen.getByRole('textbox', { name: '2 行 1 列' })
    const end = screen.getByRole('textbox', { name: '3 行 2 列' })
    fireEvent.mouseDown(start)
    fireEvent.mouseMove(end)
    fireEvent.mouseUp(document)
    expect(start.parentElement?.getAttribute('aria-selected')).toBe('true')
    expect(end.parentElement?.getAttribute('aria-selected')).toBe('true')
    expect(start.parentElement?.getAttribute('data-selection-edge')).toContain('top')
    expect(end.parentElement?.getAttribute('data-selection-edge')).toContain('bottom')
  })

  it('gives wide tables a horizontal overflow width', () => {
    render(<TableEditorDialog initialRows={2} initialColumns={99} onCancel={vi.fn()} onInsert={vi.fn()} />)
    expect(screen.getByRole('table').getAttribute('style')).toContain('width: 11880px')
  })

  it('uses the top-left of a selected range as the paste anchor', () => {
    render(<TableEditorDialog initialRows={3} initialColumns={3} onCancel={vi.fn()} onInsert={vi.fn()} />)
    const start = screen.getByRole('textbox', { name: '2 行 1 列' })
    const end = screen.getByRole('textbox', { name: '3 行 2 列' })
    fireEvent.mouseDown(start)
    fireEvent.mouseMove(end)
    fireEvent.mouseUp(document)
    fireEvent.paste(start, { clipboardData: { getData: () => 'A\tB' } })
    expect((screen.getByRole('textbox', { name: '2 行 1 列' }) as HTMLInputElement).value).toBe('A')
    expect((screen.getByRole('textbox', { name: '2 行 2 列' }) as HTMLInputElement).value).toBe('B')
  })

  it('undoes typed cell content with Ctrl+Z', async () => {
    const user = userEvent.setup()
    render(<TableEditorDialog initialRows={2} initialColumns={2} onCancel={vi.fn()} onInsert={vi.fn()} />)
    const cell = screen.getByRole('textbox', { name: '2 行 1 列' })
    await user.type(cell, '内容')
    await user.keyboard('{Control>}z{/Control}')
    expect((cell as HTMLInputElement).value).toBe('内')
  })

  it('moves between cells with arrow keys', async () => {
    const user = userEvent.setup()
    render(<TableEditorDialog initialRows={3} initialColumns={3} onCancel={vi.fn()} onInsert={vi.fn()} />)
    const cell = screen.getByRole('textbox', { name: '2 行 2 列' })
    await user.click(cell)
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '3 行 2 列' }))
    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '3 行 3 列' }))
  })

  it('moves vertically even when a cell has content', async () => {
    const user = userEvent.setup()
    render(<TableEditorDialog initialRows={3} initialColumns={2} onCancel={vi.fn()} onInsert={vi.fn()} />)
    const cell = screen.getByRole('textbox', { name: '2 行 2 列' })
    await user.type(cell, '内容')
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '3 行 2 列' }))
  })

  it('leaves a cell after two boundary arrows', async () => {
    const user = userEvent.setup()
    render(<TableEditorDialog initialRows={2} initialColumns={2} onCancel={vi.fn()} onInsert={vi.fn()} />)
    const cell = screen.getByRole('textbox', { name: '2 行 2 列' })
    await user.type(cell, '内容')
    await user.keyboard('{Home}{ArrowLeft}{ArrowLeft}')
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '2 行 1 列' }))
  })
})
