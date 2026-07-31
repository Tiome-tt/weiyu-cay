import { markdown as markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useEffect, useLayoutEffect, useRef } from 'react'

interface MarkdownSourceProps {
  markdown: string
  onChange(markdown: string): void
  onScroll?(scrollTop: number): void
  onScrollElement?(element: HTMLElement | null): void
}

export function MarkdownSource({
  markdown,
  onChange,
  onScroll,
  onScrollElement,
}: MarkdownSourceProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onScrollRef = useRef(onScroll)
  const onScrollElementRef = useRef(onScrollElement)
  const reconcilingRef = useRef(false)

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
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !reconcilingRef.current) {
            onChangeRef.current(update.state.doc.toString())
          }
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
