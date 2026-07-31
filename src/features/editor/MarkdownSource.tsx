import { markdown as markdownLanguage } from '@codemirror/lang-markdown'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { NoteId } from '../../domain/model'
import type { AssetPort } from '../../domain/ports'
import { handleImagePaste } from './imagePaste'

interface MarkdownSourceProps {
  markdown: string
  onChange(markdown: string): void
  noteId?: NoteId
  assets?: AssetPort
  onImageError?(message: string | null): void
  onScroll?(scrollTop: number): void
  onScrollElement?(element: HTMLElement | null): void
  readOnly?: boolean
}

export function MarkdownSource({
  markdown,
  onChange,
  noteId,
  assets,
  onImageError,
  onScroll,
  onScrollElement,
  readOnly = false,
}: MarkdownSourceProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onScrollRef = useRef(onScroll)
  const onScrollElementRef = useRef(onScrollElement)
  const reconcilingRef = useRef(false)
  const noteIdRef = useRef(noteId)
  const assetsRef = useRef(assets)
  const onImageErrorRef = useRef(onImageError)
  const editorGenerationRef = useRef(0)
  const readOnlyRef = useRef(readOnly)
  const editableCompartmentRef = useRef(new Compartment())

  if (noteIdRef.current !== noteId) {
    noteIdRef.current = noteId
    editorGenerationRef.current += 1
  }
  assetsRef.current = assets
  onImageErrorRef.current = onImageError
  readOnlyRef.current = readOnly

  onChangeRef.current = onChange
  onScrollRef.current = onScroll
  onScrollElementRef.current = onScrollElement

  useLayoutEffect(() => {
    const parent = hostRef.current
    if (parent === null) return
    const state = EditorState.create({
      doc: markdown,
      extensions: [
        markdownLanguage(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          'aria-label': 'Markdown source',
          'aria-multiline': 'true',
          spellcheck: 'true',
        }),
        editableCompartmentRef.current.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({ 'aria-readonly': String(readOnly) }),
        ]),
        EditorState.transactionFilter.of((transaction) =>
          readOnlyRef.current && transaction.docChanged && !reconcilingRef.current ? [] : transaction,
        ),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !reconcilingRef.current) {
            onChangeRef.current(update.state.doc.toString())
          }
        }),
        EditorView.domEventHandlers({
          paste: (event, pasteView) => {
            if (readOnlyRef.current) {
              event.preventDefault()
              return true
            }
            const originatingNoteId = noteIdRef.current
            const originatingGeneration = editorGenerationRef.current
            const assetPort = assetsRef.current
            if (originatingNoteId === undefined || assetPort === undefined) return false
            const selection = pasteView.state.selection.main
            const originatingMarkdown = pasteView.state.doc.toString()
            void handleImagePaste(event, { noteId: originatingNoteId, assets: assetPort }).then(
              (result) => {
                if (
                  noteIdRef.current !== originatingNoteId ||
                  editorGenerationRef.current !== originatingGeneration ||
                  viewRef.current !== pasteView ||
                  pasteView.state.doc.toString() !== originatingMarkdown
                ) {
                  return
                }
                if (result.kind === 'failure') {
                  onImageErrorRef.current?.(result.message)
                  return
                }
                if (result.kind !== 'success') return
                onImageErrorRef.current?.(null)
                pasteView.dispatch({
                  changes: { from: selection.from, to: selection.to, insert: result.markdown },
                  selection: { anchor: selection.from + result.markdown.length },
                })
              },
            )
            return event.defaultPrevented
          },
        }),
        EditorView.theme({
          '&': { height: '100%' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit' },
          '.cm-content': { minHeight: '100%', padding: '24px 28px' },
          '&.cm-focused': { outline: 'none' },
        }),
      ],
    })
    const view = new EditorView({ state, parent })
    viewRef.current = view

    Object.defineProperty(view.contentDOM, 'value', {
      configurable: true,
      get: () => view.state.doc.toString(),
    })

    const handleScroll = () => onScrollRef.current?.(view.scrollDOM.scrollTop)
    view.scrollDOM.addEventListener('scroll', handleScroll)
    onScrollElementRef.current?.(view.scrollDOM)

    return () => {
      onScrollElementRef.current?.(null)
      view.scrollDOM.removeEventListener('scroll', handleScroll)
      view.destroy()
      viewRef.current = null
    }
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    view.dispatch({
      effects: editableCompartmentRef.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorView.contentAttributes.of({ 'aria-readonly': String(readOnly) }),
      ]),
    })
  }, [readOnly])

  useEffect(() => {
    const view = viewRef.current
    if (view === null || view.state.doc.toString() === markdown) return
    const scrollTop = view.scrollDOM.scrollTop
    reconcilingRef.current = true
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: markdown } })
      view.scrollDOM.scrollTop = scrollTop
    } finally {
      reconcilingRef.current = false
    }
  }, [markdown])

  return <div className="markdown-source" ref={hostRef} />
}
