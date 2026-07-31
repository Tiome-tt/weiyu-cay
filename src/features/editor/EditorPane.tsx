import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { EditorMode, NoteDocument } from '../../domain/model'
import type { NotePort } from '../../domain/ports'
import { MarkdownPreview } from './MarkdownPreview'
import { MarkdownSource } from './MarkdownSource'
import { useAutosave, type SaveState } from './useAutosave'

interface EditorPaneProps {
  document: NoteDocument
  notes: Pick<NotePort, 'saveNote'>
  autosaveDelayMs?: number
}

const modes: ReadonlyArray<{ mode: EditorMode; label: string; icon: string }> = [
  { mode: 'source', label: '源码视图', icon: '<>' },
  { mode: 'split', label: '分栏视图', icon: '◫' },
  { mode: 'preview', label: '预览视图', icon: '◉' },
]

const minimumSplitPercent = 25
const maximumSplitPercent = 75
const defaultSplitPercent = 50

export function EditorPane({ document, notes, autosaveDelayMs }: EditorPaneProps) {
  const [mode, setMode] = useState<EditorMode>('source')
  const [splitPercent, setSplitPercent] = useState(defaultSplitPercent)
  const previewRef = useRef<HTMLElement>(null)
  const sourceScrollRef = useRef<HTMLElement | null>(null)
  const splitPointerRef = useRef<number | null>(null)
  const autosave = useAutosave(document, notes, { delayMs: autosaveDelayMs })

  const syncSourceToPreview = (scrollTop: number) => {
    if (mode !== 'split' || previewRef.current === null || sourceScrollRef.current === null) return
    syncScrollPosition(sourceScrollRef.current, previewRef.current, scrollTop)
  }

  const syncPreviewToSource = () => {
    if (mode !== 'split' || previewRef.current === null || sourceScrollRef.current === null) return
    syncScrollPosition(previewRef.current, sourceScrollRef.current, previewRef.current.scrollTop)
  }

  const resizeFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (splitPointerRef.current !== event.pointerId) return
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect()
    if (bounds === undefined || bounds.width <= 0) return
    const requested = Math.round(((event.clientX - bounds.left) / bounds.width) * 100)
    setSplitPercent(clampSplitPercent(requested))
  }

  const resizeFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setSplitPercent((value) => clampSplitPercent(value - 2))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setSplitPercent((value) => clampSplitPercent(value + 2))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setSplitPercent(minimumSplitPercent)
    } else if (event.key === 'End') {
      event.preventDefault()
      setSplitPercent(maximumSplitPercent)
    }
  }

  return (
    <div className="editor-pane">
      <header className="editor-toolbar" role="toolbar" aria-label="编辑器视图">
        <div className="editor-toolbar__title">
          <span className="library-pane__eyebrow">笔记</span>
          <h2>{document.title}</h2>
        </div>
        <div className="editor-toolbar__actions">
          <SaveStatus state={autosave.state} />
          {modes.map((item) => (
            <button
              key={item.mode}
              type="button"
              className="editor-mode-button"
              aria-label={item.label}
              aria-pressed={mode === item.mode}
              title={item.label}
              onClick={() => setMode(item.mode)}
            >
              <span aria-hidden="true">{item.icon}</span>
            </button>
          ))}
        </div>
      </header>
      <div
        className={`editor-document editor-document--${mode}`}
        style={
          mode === 'split'
            ? { gridTemplateColumns: `${splitPercent}fr 8px ${100 - splitPercent}fr` }
            : undefined
        }
      >
        <div className="editor-document__source" hidden={mode === 'preview'}>
          <MarkdownSource
            markdown={autosave.markdown}
            onChange={autosave.updateMarkdown}
            onScroll={syncSourceToPreview}
            onScrollElement={(element) => {
              sourceScrollRef.current = element
            }}
          />
        </div>
        <div
          className="editor-split-divider"
          role="separator"
          aria-label="Resize editor split"
          aria-orientation="vertical"
          aria-valuemin={minimumSplitPercent}
          aria-valuemax={maximumSplitPercent}
          aria-valuenow={splitPercent}
          hidden={mode !== 'split'}
          tabIndex={mode === 'split' ? 0 : -1}
          onPointerDown={(event) => {
            splitPointerRef.current = event.pointerId
            event.currentTarget.setPointerCapture?.(event.pointerId)
          }}
          onPointerMove={resizeFromPointer}
          onPointerUp={(event) => {
            if (splitPointerRef.current !== event.pointerId) return
            splitPointerRef.current = null
            event.currentTarget.releasePointerCapture?.(event.pointerId)
          }}
          onDoubleClick={() => setSplitPercent(defaultSplitPercent)}
          onKeyDown={resizeFromKeyboard}
        />
        <div className="editor-document__preview" hidden={mode === 'source'}>
          <MarkdownPreview
            ref={previewRef}
            markdown={autosave.markdown}
            onScroll={syncPreviewToSource}
          />
        </div>
      </div>
    </div>
  )
}

function SaveStatus({ state }: { state: SaveState }) {
  if (state.status === 'idle') return null
  if (state.status === 'error') {
    return (
      <span className="editor-save editor-save--error" role="alert">
        <span>{state.message}</span>
        <button type="button" aria-label="重试保存" onClick={state.retry}>
          重试
        </button>
      </span>
    )
  }
  return (
    <span className="editor-save" role="status">
      {state.status}
    </span>
  )
}

function syncScrollPosition(source: HTMLElement, target: HTMLElement, sourceTop: number) {
  const sourceRange = Math.max(0, source.scrollHeight - source.clientHeight)
  const targetRange = Math.max(0, target.scrollHeight - target.clientHeight)
  target.scrollTop = sourceRange === 0 ? sourceTop : (sourceTop / sourceRange) * targetRange
}

function clampSplitPercent(value: number) {
  return Math.min(maximumSplitPercent, Math.max(minimumSplitPercent, value))
}
