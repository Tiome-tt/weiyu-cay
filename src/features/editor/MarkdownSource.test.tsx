import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownSource } from './MarkdownSource'

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
})
