import { markdown as markdownLanguage } from '@codemirror/lang-markdown'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
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

export interface MarkdownSourceHandle {
  beginEditBarrier(): Promise<void>
  endEditBarrier(): void
}

interface PendingPaste {
  from: number
  to: number
  settled: Promise<void>
}

export const MarkdownSource = forwardRef<MarkdownSourceHandle, MarkdownSourceProps>(function MarkdownSource({
  markdown,
  onChange,
  noteId,
  assets,
  onImageError,
  onScroll,
  onScrollElement,
  readOnly = false,
}: MarkdownSourceProps, ref) {
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
  const barrierLockedRef = useRef(false)
  const internalEditRef = useRef(false)
  const pendingPastesRef = useRef(new Map<symbol, PendingPaste>())
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

  const configureEditable = (view: EditorView | null) => {
    if (view === null) return
    const locked = readOnlyRef.current || barrierLockedRef.current
    view.dispatch({
      effects: editableCompartmentRef.current.reconfigure([
        EditorState.readOnly.of(locked),
        EditorView.editable.of(!locked),
        EditorView.contentAttributes.of({ 'aria-readonly': String(locked) }),
      ]),
    })
  }

  useImperativeHandle(ref, () => ({
    beginEditBarrier: async () => {
      barrierLockedRef.current = true
      configureEditable(viewRef.current)
      const pending = Array.from(pendingPastesRef.current.values(), (entry) => entry.settled)
      await Promise.allSettled(pending)
    },
    endEditBarrier: () => {
      barrierLockedRef.current = false
      configureEditable(viewRef.current)
    },
  }))

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
          (readOnlyRef.current || barrierLockedRef.current) &&
          transaction.docChanged &&
          !reconcilingRef.current &&
          !internalEditRef.current
            ? []
            : transaction,
        ),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            for (const entry of pendingPastesRef.current.values()) {
              if (entry.from === entry.to) {
                entry.from = update.changes.mapPos(entry.from, 1)
                entry.to = entry.from
              } else {
                entry.from = update.changes.mapPos(entry.from, -1)
                entry.to = update.changes.mapPos(entry.to, 1)
              }
            }
          }
          if (update.docChanged && !reconcilingRef.current) {
            onChangeRef.current(update.state.doc.toString())
          }
        }),
        EditorView.domEventHandlers({
          paste: (event, pasteView) => {
            if (readOnlyRef.current || barrierLockedRef.current) {
              event.preventDefault()
              return true
            }
            const originatingNoteId = noteIdRef.current
            const originatingGeneration = editorGenerationRef.current
            const assetPort = assetsRef.current
            if (originatingNoteId === undefined || assetPort === undefined) return false
            const selection = pasteView.state.selection.main
            const token = Symbol('pending-image-paste')
            let settle!: () => void
            const settled = new Promise<void>((resolve) => { settle = resolve })
            pendingPastesRef.current.set(token, { from: selection.from, to: selection.to, settled })
            void handleImagePaste(event, { noteId: originatingNoteId, assets: assetPort })
              .then((result) => {
                const pending = pendingPastesRef.current.get(token)
                if (
                  pending === undefined ||
                  noteIdRef.current !== originatingNoteId ||
                  editorGenerationRef.current !== originatingGeneration ||
                  viewRef.current !== pasteView
                ) {
                  return
                }
                if (result.kind === 'failure') {
                  onImageErrorRef.current?.(result.message)
                  return
                }
                if (result.kind !== 'success') return
                onImageErrorRef.current?.(null)
                internalEditRef.current = true
                try {
                  pasteView.dispatch({
                    changes: { from: pending.from, to: pending.to, insert: result.markdown },
                    selection: { anchor: pending.from + result.markdown.length },
                  })
                } finally {
                  internalEditRef.current = false
                }
              })
              .finally(() => {
                pendingPastesRef.current.delete(token)
                settle()
              })
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
    configureEditable(view)
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
})
