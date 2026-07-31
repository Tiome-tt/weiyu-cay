import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeNotePort, note } from '../../test/fakes'
import { EditorPane } from './EditorPane'

afterEach(cleanup)

const labels = ['源码视图', '分栏视图', '预览视图']

function view() {
  const textbox = screen.getByRole('textbox', { name: 'Markdown source' })
  const editor = EditorView.findFromDOM(textbox)
  if (editor === null) throw new Error('CodeMirror view not found')
  return editor
}

describe('EditorPane', () => {
  it('places the note title and exactly three primary view controls in the editor toolbar', () => {
    render(<EditorPane document={{ ...note('# Goal'), title: 'Goal' }} notes={fakeNotePort()} />)

    const toolbar = screen.getByRole('toolbar', { name: '编辑器视图' })
    expect(within(toolbar).getByRole('heading', { name: 'Goal' })).toBeVisible()
    expect(within(toolbar).getAllByRole('button')).toHaveLength(3)
    labels.forEach((label) => {
      const button = within(toolbar).getByRole('button', { name: label })
      expect(button).toHaveAttribute('title', label)
    })
    expect(within(toolbar).getByRole('button', { name: labels[0] })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('keeps one document while switching source, split, and preview modes', async () => {
    const user = userEvent.setup()
    render(<EditorPane document={note('# Goal')} notes={fakeNotePort()} />)

    expect(screen.getByRole('textbox', { name: 'Markdown source' })).toBeVisible()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: labels[1] }))
    expect(view().state.doc.toString()).toBe('# Goal')
    expect(screen.getByRole('article')).toHaveTextContent('Goal')
    expect(screen.getByRole('button', { name: labels[1] })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: labels[2] }))
    expect(screen.queryByRole('textbox', { name: 'Markdown source' })).not.toBeInTheDocument()
    expect(screen.getByRole('article')).toHaveTextContent('Goal')
    expect(screen.getByRole('button', { name: labels[2] })).toHaveAttribute('aria-pressed', 'true')
  })

  it('updates split preview immediately from the single source state', async () => {
    const user = userEvent.setup()
    render(<EditorPane document={note('# Old')} notes={fakeNotePort()} autosaveDelayMs={10_000} />)
    await user.click(screen.getByRole('button', { name: labels[1] }))

    const editor = view()
    act(() => {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '## New' } })
    })

    expect(screen.getByRole('article')).toHaveTextContent('New')
    expect(screen.getByRole('article')).not.toHaveTextContent('Old')
  })

  it('preserves CodeMirror selection and source and preview scroll positions across modes', async () => {
    const user = userEvent.setup()
    render(<EditorPane document={note('one\ntwo\nthree')} notes={fakeNotePort()} />)
    const editor = view()
    editor.dispatch({ selection: EditorSelection.cursor(5) })
    editor.scrollDOM.scrollTop = 31

    await user.click(screen.getByRole('button', { name: labels[1] }))
    const preview = screen.getByRole('article')
    preview.scrollTop = 46
    await user.click(screen.getByRole('button', { name: labels[2] }))
    await user.click(screen.getByRole('button', { name: labels[1] }))

    expect(view().state.selection.main.head).toBe(5)
    expect(view().scrollDOM.scrollTop).toBe(31)
    expect(screen.getByRole('article').scrollTop).toBe(46)
  })

  it('synchronizes split source scrolling with the preview', async () => {
    const user = userEvent.setup()
    render(<EditorPane document={note('one\ntwo\nthree')} notes={fakeNotePort()} />)
    await user.click(screen.getByRole('button', { name: labels[1] }))
    const source = view().scrollDOM
    const preview = screen.getByRole('article')
    Object.defineProperties(source, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    })
    Object.defineProperties(preview, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 900 },
    })
    source.scrollTop = 200

    fireEvent.scroll(source)

    expect(preview.scrollTop).toBe(400)
  })

  it('resizes the internal split with pointer and keyboard controls and resets on double click', async () => {
    const user = userEvent.setup()
    render(<EditorPane document={note('one\ntwo\nthree')} notes={fakeNotePort()} />)
    await user.click(screen.getByRole('button', { name: labels[1] }))
    const divider = screen.getByRole('separator', { name: 'Resize editor split' })
    const documentBody = divider.parentElement
    if (documentBody === null) throw new Error('editor document body not found')
    vi.spyOn(documentBody, 'getBoundingClientRect').mockReturnValue({
      bottom: 600,
      height: 600,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    fireEvent.pointerDown(divider, { clientX: 400, pointerId: 1 })
    fireEvent.pointerMove(divider, { clientX: 520, pointerId: 1 })
    fireEvent.pointerUp(divider, { pointerId: 1 })
    expect(divider).toHaveAttribute('aria-valuenow', '65')

    divider.focus()
    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    expect(divider).toHaveAttribute('aria-valuenow', '63')
    fireEvent.doubleClick(divider)
    expect(divider).toHaveAttribute('aria-valuenow', '50')
  })

  it('keeps a save failure visible with a keyboard-accessible retry action', async () => {
    const saveNote = vi
      .fn()
      .mockRejectedValueOnce(new Error('private storage detail'))
      .mockImplementationOnce(async (document) => ({ ...document, revision: 2 }))
    render(
      <EditorPane
        document={note('old')}
        notes={fakeNotePort({ saveNote })}
        autosaveDelayMs={10_000}
      />,
    )
    const editor = view()
    act(() => {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'kept draft' } })
      window.dispatchEvent(new Event('blur'))
    })

    const alert = await screen.findByRole('alert')
    expect(alert).not.toHaveTextContent('private storage detail')
    const retry = within(alert).getByRole('button', { name: '重试保存' })
    retry.focus()
    expect(retry).toHaveFocus()
    await userEvent.click(retry)

    await waitFor(() => expect(saveNote).toHaveBeenCalledTimes(2))
    expect(saveNote).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: 'kept draft' }))
  })
})
