import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { emptyRichDocument } from '../../domain/content'
import { chooseTablePickerSide, RichDocumentEditor, nextRichDocumentZoom, type RichDocumentEditorHandle } from './RichDocumentEditor'
import { NotificationProvider } from '../../shared/notifications'

beforeAll(() => {
 Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.querySelector('.tiptap') })
 Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] })
 Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(0,0,10,10) })
})
afterEach(cleanup)

describe('RichDocumentEditor', () => {
  it('shows an invalid link error as a bottom-right notification without shifting the toolbar', async () => {
    render(<NotificationProvider><RichDocumentEditor value={emptyRichDocument()} onChange={vi.fn()} /></NotificationProvider>)
    fireEvent.contextMenu(screen.getByRole('textbox', { name: '文档正文' }), { clientX: 20, clientY: 30 })
    fireEvent.click(screen.getByRole('menuitem', { name: '超链接' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '插入超链接' })).getByRole('button', { name: '插入' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('请输入完整的 http 或 https 链接。')
    expect(screen.getByRole('alert')).toHaveClass('notification-center__item')
    expect(document.querySelector('.rich-document__error')).not.toBeInTheDocument()
  })
  it('sets each heading level from the toolbar and returns to a paragraph', async () => {
    const onChange = vi.fn()
    render(<RichDocumentEditor value={{ schemaVersion: 1, root: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '保留正文' }] }] } }} onChange={onChange} />)
    const body = screen.getByRole('textbox', { name: '文档正文' })
    fireEvent.focus(body)
    const style = screen.getByRole('button', { name: '段落样式' })
    expect(style).toHaveTextContent('H')
    for (const level of [1, 2, 3, 4, 5, 6]) {
      fireEvent.click(style)
      fireEvent.click(screen.getByRole('menuitemradio', { name: '标题 ' + level }))
      await waitFor(() => expect(body.querySelector('h' + level)).toHaveTextContent('保留正文'))
      fireEvent.click(style)
      expect(screen.getByRole('menuitemradio', { name: '标题 ' + level })).toHaveAttribute('aria-checked', 'true')
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    }
    fireEvent.click(style)
    fireEvent.click(screen.getByRole('menuitemradio', { name: '正文' }))
    await waitFor(() => expect(body.querySelector('p')).toHaveTextContent('保留正文'))
    expect(style).toHaveTextContent('H')
    expect(onChange).toHaveBeenCalled()
  })

  it('chooses the side with enough viewport space for the table picker', () => {
    expect(chooseTablePickerSide({ triggerLeft: 900, triggerRight: 950, pickerWidth: 180, viewportWidth: 1024 })).toBe('left')
    expect(chooseTablePickerSide({ triggerLeft: 500, triggerRight: 550, pickerWidth: 180, viewportWidth: 1024 })).toBe('right')
  })
  it('changes document zoom with Ctrl+wheel while keeping the zoom bounded', () => {
    expect(nextRichDocumentZoom(1, -100)).toBe(1.1)
    expect(nextRichDocumentZoom(1, 100)).toBe(0.9)
    expect(nextRichDocumentZoom(2, -100)).toBe(2)
    expect(nextRichDocumentZoom(0.5, 100)).toBe(0.5)

    render(<RichDocumentEditor value={emptyRichDocument()} onChange={vi.fn()} />)
    const surface = document.querySelector('.rich-document__surface') as HTMLElement
    fireEvent.wheel(surface, { ctrlKey: true, deltaY: -100 })
    expect(surface).toHaveStyle('--rich-document-zoom: 1.1')
    fireEvent.wheel(surface, { ctrlKey: false, deltaY: -100 })
    expect(surface).toHaveStyle('--rich-document-zoom: 1.1')
  })
  it('exposes icon paragraph alignment buttons, font, and numeric size controls', () => {
    render(<RichDocumentEditor value={emptyRichDocument()} onChange={vi.fn()} />)
    expect(screen.getByRole('group', { name: '正文对齐' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '左对齐' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '居中对齐' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '右对齐' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '两端对齐' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '字体' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '字号' })).toHaveAttribute('inputmode', 'numeric')
    expect(screen.getByRole('button', { name: '字号选项' })).toBeInTheDocument()
  })
  it('collapses and expands the rich-document formatting toolbar', async () => {
    render(<RichDocumentEditor value={emptyRichDocument()} onChange={vi.fn()} />)
    const toolbar = screen.getByRole('toolbar', { name: '文档格式' })
    const toggle = screen.getByRole('button', { name: '收起格式工具栏' })

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)
    expect(toolbar).toHaveClass('rich-document__toolbar--collapsed')
    expect(screen.getByRole('button', { name: '展开格式工具栏' })).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('button', { name: '展开格式工具栏' }))
    expect(toolbar).not.toHaveClass('rich-document__toolbar--collapsed')
    expect(screen.getByRole('button', { name: '收起格式工具栏' })).toHaveAttribute('aria-expanded', 'true')
  })
  it('applies a custom numeric font size from the integrated size control', async () => {
    const onChange = vi.fn()
    render(<RichDocumentEditor value={emptyRichDocument()} onChange={onChange} />)
    const user = userEvent.setup()
    const editor = screen.getByRole('textbox', { name: '文档正文' })
    await user.click(editor)
    await user.type(editor, 'X')
    const input = screen.getByRole('textbox', { name: '字号' })
    await user.clear(input)
    await user.type(input, '18')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(editor).toHaveFocus())
    await user.keyboard('Y')
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      root: expect.objectContaining({
        content: expect.arrayContaining([expect.objectContaining({
          content: expect.arrayContaining([expect.objectContaining({ text: 'Y', marks: [{ type: 'font', attrs: { size: '18' } }] })]),
        })]),
      }),
    }))
  })

  it('uses compact icon controls with hover labels and an ordered-list insertion action', async () => {
    render(<RichDocumentEditor value={{ schemaVersion: 1, root: { type: 'doc', content: [{ type: 'paragraph' }] } }} onChange={vi.fn()} />)
    const highlight = screen.getByRole('button', { name: '高亮' })
    expect(highlight).toHaveAttribute('title', '高亮')
    expect(highlight).not.toHaveTextContent('高亮')
    const font = screen.getByRole('button', { name: '字体' })
    expect(font).not.toHaveAttribute('title')
    expect(font).toHaveTextContent('默认字体')
    const size = screen.getByRole('group', { name: '字号' })
    expect(size.querySelectorAll('input, button')).toHaveLength(2)
    const insert = screen.getByRole('button', { name: '插入' })
    expect(insert).toHaveAttribute('title', '插入')
    expect(insert.querySelector('svg')).not.toBeNull()
    await userEvent.setup().click(insert)
    expect(screen.getByRole('menuitem', { name: '有序列表' })).toBeInTheDocument()
  })
  it('renders headings as one editable content region without a marker', () => {
    render(<RichDocumentEditor value={{schemaVersion:1,root:{type:'doc',content:[{type:'heading',attrs:{level:2},content:[{type:'text',text:'旧标题'}]}]}}} onChange={vi.fn()}/>)
    const heading=screen.getByRole('heading',{level:2})
    expect(heading).toHaveAttribute('data-rich-heading','true')
    expect(heading.querySelector('.rich-document__source-prefix')).toHaveClass('is-hidden')
    expect(heading.querySelector('.rich-document__heading-marker')).toBeNull()
  })
  it('edits a document and emits the versioned app schema', async () => {
    const onChange = vi.fn()
    render(<RichDocumentEditor value={emptyRichDocument()} onChange={onChange} />)

    const editor = screen.getByRole('textbox', { name: '文档正文' })
    await userEvent.setup().click(editor)
    await userEvent.setup().type(editor, '微屿文档')

    expect(onChange).toHaveBeenLastCalledWith({
      schemaVersion: 1,
      root: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '微屿文档' }] }] },
    })
  })

  it('opens external links only from a modified click', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    const value = {
      schemaVersion: 1 as const,
      root: {
        type: 'doc' as const,
        content: [{
          type: 'paragraph' as const,
          content: [{ type: 'text' as const, text: '哔哩哔哩', marks: [{ type: 'link', attrs: { href: 'https://www.bilibili.com/video/BV1test' } }] }],
        }],
      },
    }
    render(<RichDocumentEditor value={value} onChange={vi.fn()} external={{ openExternal }} />)
    const link = screen.getByRole('link', { name: '哔哩哔哩' })
    fireEvent.click(link)
    expect(openExternal).not.toHaveBeenCalled()
    fireEvent.click(link, { ctrlKey: true })
    expect(openExternal).toHaveBeenCalledWith('https://www.bilibili.com/video/BV1test')
  })

  it('resizes an embedded image and persists its width', () => {
    const onChange = vi.fn()
    const value = {
      schemaVersion: 1 as const,
      root: {
        type: 'doc' as const,
        content: [{
          type: 'image' as const,
          attrs: {
            src: 'assets/screenshot-019c0000-0000-7000-8000-000000000002.png',
            alt: '架构图',
            width: 240,
          },
        }],
      },
    }
    render(<RichDocumentEditor value={value} onChange={onChange} />)
    const image = document.querySelector('.rich-document__content img') as HTMLImageElement
    const handle = screen.getByRole('button', { name: '调整图片大小' })
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 240, 120))

    fireEvent.pointerDown(handle, { clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 300 })
    fireEvent.pointerUp(window, { clientX: 300 })

    expect(onChange.mock.calls.some(([next]) => next.root.content?.[0]?.attrs?.width === 440)).toBe(true)
  })
  it('offers image copying from the document context menu', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } })
    class TestClipboardItem {
      constructor(public readonly items: Record<string, Blob>) {}
    }
    vi.stubGlobal('ClipboardItem', TestClipboardItem)
    expect(typeof ClipboardItem).toBe('function')
    expect(navigator.clipboard.write).toBe(write)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) }))
    const value = {
      schemaVersion: 1 as const,
      root: { type: 'doc' as const, content: [{ type: 'image' as const, attrs: { src: 'assets/screenshot-019c0000-0000-7000-8000-000000000002.png', alt: '架构图', width: 240 } }] },
    }
    render(<RichDocumentEditor value={value} onChange={vi.fn()} />)
    const image = document.querySelector('.rich-document__content img') as HTMLImageElement
    fireEvent.contextMenu(image, { clientX: 40, clientY: 50 })
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
    fireEvent.click(screen.getByRole('menuitem', { name: '复制图片' }))

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    vi.unstubAllGlobals()
  })
  it('turns a pasted URL into a safe link mark', () => {
    render(<RichDocumentEditor value={emptyRichDocument()} onChange={vi.fn()} />)
    const editor = screen.getByRole('textbox', { name: '文档正文' })
    fireEvent.paste(editor, { clipboardData: { getData: (type: string) => type === 'text/plain' ? 'https://www.bilibili.com/video/BV1test' : '' } })
    expect(editor.querySelector('a')?.getAttribute('href')).toBe('https://www.bilibili.com/video/BV1test')
  })
  it('keeps composition text when a save barrier settles the editor', async () => {
    const onChange = vi.fn()
    const ref = createRef<RichDocumentEditorHandle>()
    render(<RichDocumentEditor ref={ref} value={emptyRichDocument()} onChange={onChange} />)
    const editor = screen.getByRole('textbox', { name: '文档正文' })

    fireEvent.compositionStart(editor)
    editor.querySelector('p')!.textContent = '屿'
    fireEvent(editor, new InputEvent('input', {bubbles:true,data:'屿',inputType:'insertCompositionText'}))
    fireEvent.compositionEnd(editor, { data: '屿' })
    await act(async () => { await ref.current?.commitComposition() })

    expect(JSON.stringify(onChange.mock.calls)).toContain('屿')
    expect(ref.current).toMatchObject({
      focus: expect.any(Function),
      navigateToHeading: expect.any(Function),
      commitComposition: expect.any(Function),
    })
  })


  it('selects a rectangular cell range by dragging across cells', async () => {
    const onChange = vi.fn()
    const value = {
      schemaVersion: 1 as const,
      root: {
        type: 'doc' as const,
        content: [{
          type: 'table' as const,
          content: [
            { type: 'tableRow' as const, content: [{ type: 'tableCell' as const, content: [{ type: 'paragraph' as const }] }, { type: 'tableCell' as const, content: [{ type: 'paragraph' as const }] }] },
            { type: 'tableRow' as const, content: [{ type: 'tableCell' as const, content: [{ type: 'paragraph' as const }] }, { type: 'tableCell' as const, content: [{ type: 'paragraph' as const }] }] },
          ],
        }],
      },
    }
    render(<RichDocumentEditor value={value} onChange={onChange} />)
    const table = document.querySelector('table')!
    const cells = Array.from(table.querySelectorAll<HTMLTableCellElement>('td,th'))
    const surface = document.querySelector('.rich-document__surface')!
    fireEvent.mouseDown(cells[0])
    fireEvent.mouseMove(cells[3])
    fireEvent.mouseUp(surface)
    expect(table.querySelectorAll('.selectedCell').length).toBe(4)
  })

  it('preserves document scroll when a controlled save acknowledgement updates content', async () => {
    const onChange = vi.fn()
    const initial = {
      schemaVersion: 1 as const,
      root: {
        type: 'doc' as const,
        content: Array.from({ length: 12 }, (_, index) => ({ type: 'paragraph' as const, content: [{ type: 'text' as const, text: '第 ' + index + ' 段' }] })),
      },
    }
    const { rerender } = render(<RichDocumentEditor value={initial} onChange={onChange} />)
    const surface = document.querySelector('.rich-document__surface') as HTMLElement
    surface.scrollTop = 240
    const updated = { ...initial, root: { ...initial.root, content: [...initial.root.content!, { type: 'paragraph' as const, content: [{ type: 'text' as const, text: '保存后的内容' }] }] } }
    await act(async () => {
      rerender(<RichDocumentEditor value={updated} onChange={onChange} />)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
    expect(surface.scrollTop).toBe(240)
  })

  it('inserts a table through an accessible editor command', async () => {
    const onChange = vi.fn()
    render(<RichDocumentEditor value={emptyRichDocument()} onChange={onChange} />)

    await userEvent.setup().click(screen.getByRole('button', { name: '插入' }))
    await userEvent.setup().click(screen.getByRole('menuitem', { name: '表格' }))
    await userEvent.setup().click(screen.getByRole('gridcell', { name: '3 行 3 列' }))

    expect(onChange.mock.calls.some(([value]) => value.root.content?.some((node: { type: string }) => node.type === 'table'))).toBe(true)
  })

  it('flips the table picker to the left when the right side is clipped', async () => {
    const innerWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('rich-document__table-picker-trigger')) return new DOMRect(900, 0, 50, 30)
      if (this.classList.contains('rich-document__table-picker-grid')) return new DOMRect(0, 0, 180, 170)
      return new DOMRect(0, 0, 0, 0)
    })
    try {
      render(<RichDocumentEditor value={emptyRichDocument()} onChange={vi.fn()} />)
      fireEvent.click(document.querySelector('.rich-document__insert-trigger') as HTMLElement)
      fireEvent.click(document.querySelector('.rich-document__table-picker-trigger') as HTMLElement)
      expect(document.querySelector('.rich-document__table-picker-grid')).toHaveAttribute('data-placement', 'left')
    } finally {
      rectSpy.mockRestore()
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth })
    }
  })
  it('inserts and edits a LaTeX formula from the editor toolbar', async () => {
    const onChange = vi.fn()
    render(<RichDocumentEditor value={emptyRichDocument()} onChange={onChange} />)

    await userEvent.setup().click(screen.getByRole('button', { name: '插入' }))
    await userEvent.setup().click(screen.getByRole('menuitem', { name: '公式' }))
    const input = screen.getByRole('textbox', { name: 'LaTeX 公式' })
    expect(input.getAttribute('placeholder')).toMatch(/例如：x_i.*frac.*sqrt/)
    fireEvent.change(input, { target: { value: '\\frac{a}{b}' } })
    await userEvent.setup().click(screen.getByRole('button', { name: '保存公式' }))

    expect(JSON.stringify(onChange.mock.calls)).toContain('math')
    expect(JSON.stringify(onChange.mock.calls)).toContain('\\frac{a}{b}')
    expect(document.querySelector('[data-rich-math="inline"]')).not.toBeNull()
  })
})

it('retains both concurrently pasted images after writes complete out of order',async()=>{
 const pending:Array<(value:{relativePath:string;width:number;height:number})=>void>=[]
 const saveImage=vi.fn(()=>new Promise<{relativePath:string;width:number;height:number}>(resolve=>pending.push(resolve)))
 const onChange=vi.fn(),handle=createRef<RichDocumentEditorHandle>()
 render(<RichDocumentEditor ref={handle} noteId={'019c0000-0000-7000-8000-000000000001' as import('../../domain/model').NoteId} value={emptyRichDocument()} onChange={onChange} assets={{saveImage}}/>)
 const body=screen.getByRole('textbox',{name:'文档正文'})
 const file={type:'image/png',name:'image.png',arrayBuffer:async()=>new Uint8Array([1]).buffer}
 fireEvent.focus(body)
 fireEvent.paste(body,{clipboardData:{files:[file],types:['Files'],getData:()=>''}})
 fireEvent.focus(body)
 fireEvent.paste(body,{clipboardData:{files:[file],types:['Files'],getData:()=>''}})
 await waitFor(()=>expect(saveImage).toHaveBeenCalledTimes(2))
 await act(async()=>{pending[1]({relativePath:'assets/screenshot-019c0000-0000-7000-8000-000000000002.png',width:2,height:2})})
 await act(async()=>{pending[0]({relativePath:'assets/screenshot-019c0000-0000-7000-8000-000000000003.png',width:2,height:2});await handle.current?.commitComposition()})
 expect(body.querySelectorAll('img')).toHaveLength(2)
 expect(onChange.mock.lastCall?.[0].root.content.filter((node:{type:string})=>node.type==='image')).toHaveLength(2)
})
