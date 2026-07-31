import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { MarkdownSource, type MarkdownSourceHandle } from './MarkdownSource'
import { fakeAssetPort, noteId, pngBytes } from '../../test/fakes'

afterEach(cleanup)

function editorView() {
  const textbox = screen.getByRole('textbox', { name: 'Markdown source' })
  const view = EditorView.findFromDOM(textbox)
  if (view === null) throw new Error('CodeMirror view not found')
  return view
}

describe('MarkdownSource', () => {
  it('publishes user transactions from the CodeMirror document', () => {
    const onChange = vi.fn()
    render(<MarkdownSource markdown="old" onChange={onChange} />)
    const view = editorView()

    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'new text' } })

    expect(onChange).toHaveBeenLastCalledWith('new text')
  })

  it('applies external documents without feedback loops', () => {
    const onChange = vi.fn()
    const { rerender } = render(<MarkdownSource markdown="old" onChange={onChange} />)

    rerender(<MarkdownSource markdown="authoritative" onChange={onChange} />)

    expect(editorView().state.doc.toString()).toBe('authoritative')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps selection and scroll when controlled content is unchanged', () => {
    const onChange = vi.fn()
    const { rerender } = render(<MarkdownSource markdown="one\ntwo\nthree" onChange={onChange} />)
    const before = editorView()
    before.dispatch({ selection: EditorSelection.cursor(5) })
    before.scrollDOM.scrollTop = 37

    rerender(<MarkdownSource markdown="one\ntwo\nthree" onChange={onChange} />)

    const after = editorView()
    expect(after.state.selection.main.head).toBe(5)
    expect(after.scrollDOM.scrollTop).toBe(37)
  })

  it('reports source scrolling for split synchronization', () => {
    const onScroll = vi.fn()
    render(<MarkdownSource markdown="one\ntwo\nthree" onChange={vi.fn()} onScroll={onScroll} />)
    const view = editorView()
    view.scrollDOM.scrollTop = 24

    fireEvent.scroll(view.scrollDOM)

    expect(onScroll).toHaveBeenLastCalledWith(24)
  })

  it('replaces the exact selection with a pasted image and places the caret after it', async () => {
    const onChange = vi.fn()
    const assets = fakeAssetPort({ relativePath: 'assets/screenshot-019c.png', width: 2, height: 3 })
    render(<MarkdownSource markdown="before selected after" noteId={noteId} assets={assets} onChange={onChange} />)
    const view = editorView()
    view.dispatch({ selection: EditorSelection.range(7, 15) })

    fireEvent.paste(view.contentDOM, {
      clipboardData: {
        files: [{ type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer }],
        getData: () => '',
      },
    })

    await vi.waitFor(() => expect(view.state.doc.toString()).toBe('before ![截图](assets/screenshot-019c.png) after'))
    expect(view.state.selection.main.head).toBe('before ![截图](assets/screenshot-019c.png)'.length)
    expect(onChange).toHaveBeenLastCalledWith('before ![截图](assets/screenshot-019c.png) after')
  })

  it('does not change the document when saving a pasted image fails', async () => {
    const onImageError = vi.fn()
    const assets = {
      saveImage: vi.fn(async () => {
        throw new Error('private path')
      }),
    }
    render(<MarkdownSource markdown="kept" noteId={noteId} assets={assets} onChange={vi.fn()} onImageError={onImageError} />)

    fireEvent.paste(editorView().contentDOM, {
      clipboardData: {
        files: [{ type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer }],
        getData: () => '',
      },
    })

    await vi.waitFor(() => expect(onImageError).toHaveBeenCalledWith('无法保存截图。'))
    expect(editorView().state.doc.toString()).toBe('kept')
  })

  it('does not insert an image resolved after the editor switches notes', async () => {
    let finish!: (value: { relativePath: string; width: number; height: number }) => void
    const assets = {
      saveImage: vi.fn(
        () =>
          new Promise<{ relativePath: string; width: number; height: number }>((resolve) => {
            finish = resolve
          }),
      ),
    }
    const { rerender } = render(<MarkdownSource markdown="note A" noteId={noteId} assets={assets} onChange={vi.fn()} />)

    fireEvent.paste(editorView().contentDOM, {
      clipboardData: {
        files: [{ type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer }],
        getData: () => '',
      },
    })
    await vi.waitFor(() => expect(assets.saveImage).toHaveBeenCalledOnce())
    const otherId = '019c0000-0000-7000-8000-000000000099' as typeof noteId
    rerender(<MarkdownSource markdown="note B" noteId={otherId} assets={assets} onChange={vi.fn()} />)
    finish({ relativePath: 'assets/orphan.png', width: 2, height: 3 })

    await vi.waitFor(() => expect(editorView().state.doc.toString()).toBe('note B'))
  })

  it('blocks CodeMirror transactions and image paste while read only, then resumes editing', () => {
    const onChange = vi.fn()
    const assets = fakeAssetPort({ relativePath: 'assets/blocked.png', width: 1, height: 1 })
    const { rerender } = render(
      <MarkdownSource markdown="kept" noteId={noteId} assets={assets} onChange={onChange} readOnly />,
    )
    const view = editorView()

    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'lost' } })
    fireEvent.paste(view.contentDOM, {
      clipboardData: {
        files: [{ type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer }],
        getData: () => '',
      },
    })

    expect(view.state.doc.toString()).toBe('kept')
    expect(view.contentDOM).toHaveAttribute('contenteditable', 'false')
    expect(onChange).not.toHaveBeenCalled()
    expect(assets.saveImage).not.toHaveBeenCalled()

    rerender(
      <MarkdownSource markdown="kept" noteId={noteId} assets={assets} onChange={onChange} readOnly={false} />,
    )
    view.dispatch({ changes: { from: 4, insert: ' editing' } })
    expect(view.state.doc.toString()).toBe('kept editing')
  })

  it('waits for every pre-barrier image paste and inserts each mapped reference', async () => {
    let finishFirst!: (value: { relativePath: string; width: number; height: number }) => void
    let finishSecond!: (value: { relativePath: string; width: number; height: number }) => void
    const assets = {
      saveImage: vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve }))
        .mockImplementationOnce(() => new Promise((resolve) => { finishSecond = resolve })),
    }
    const ref = createRef<MarkdownSourceHandle>()
    render(<MarkdownSource ref={ref} markdown="AB" noteId={noteId} assets={assets} onChange={vi.fn()} />)
    const view = editorView()
    view.dispatch({ selection: EditorSelection.cursor(1) })
    fireEvent.paste(view.contentDOM, { clipboardData: { files: [{ type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer }], getData: () => '' } })
    view.dispatch({ selection: EditorSelection.cursor(0) })
    fireEvent.paste(view.contentDOM, { clipboardData: { files: [{ type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer }], getData: () => '' } })
    await vi.waitFor(() => expect(assets.saveImage).toHaveBeenCalledTimes(2))

    const barrier = ref.current!.beginEditBarrier()
    view.dispatch({ changes: { from: 0, insert: 'blocked' } })
    expect(view.state.doc.toString()).toBe('AB')
    await act(async () => finishSecond({ relativePath: 'assets/second.png', width: 1, height: 1 }))
    await act(async () => finishFirst({ relativePath: 'assets/first.png', width: 1, height: 1 }))
    await barrier

    expect(view.state.doc.toString()).toContain('![截图](assets/first.png)')
    expect(view.state.doc.toString()).toContain('![截图](assets/second.png)')
    ref.current!.endEditBarrier()
    view.dispatch({ changes: { from: view.state.doc.length, insert: ' editable' } })
    expect(view.state.doc.toString()).toMatch(/ editable$/)
  })
})
