import { useCallback, useEffect, useRef, useState } from 'react'
import type { NoteDocument } from '../../domain/model'
import type { AssetPort, TemporaryPort, TemporaryWindowPort, TemporaryWindowState } from '../../domain/ports'
import { MarkdownSource, type MarkdownSourceHandle } from '../editor/MarkdownSource'
import { useAutosave, type SaveState } from '../editor/useAutosave'
import { StatusNotice, type StatusNoticeState } from '../../shared/StatusNotice'

interface StickyWindowProps {
  note: NoteDocument
  temporary: Pick<TemporaryPort, 'save'>
  windows: Pick<TemporaryWindowPort, 'hide' | 'setAlwaysOnTop' | 'startDragging' | 'onCloseRequested'>
  assets?: AssetPort
  autosaveDelayMs?: number
  initialWindowState?: TemporaryWindowState
}

const defaultState = (note: NoteDocument): TemporaryWindowState => ({
  noteId: note.id,
  visible: true,
  x: 48,
  y: 48,
  width: 360,
  height: 420,
  alwaysOnTop: true,
})

export function StickyWindow({
  note,
  temporary,
  windows,
  assets,
  autosaveDelayMs,
  initialWindowState,
}: StickyWindowProps) {
  const autosave = useAutosave(note, { saveNote: temporary.save }, { delayMs: autosaveDelayMs })
  const [windowState, setWindowState] = useState(initialWindowState ?? defaultState(note))
  const [windowError, setWindowError] = useState<string | null>(null)
  const sourceRef = useRef<MarkdownSourceHandle>(null)

  const hideAfterFlush = useCallback(async () => {
    setWindowError(null)
    await sourceRef.current?.beginEditBarrier()
    if (!(await autosave.flush())) {
      sourceRef.current?.endEditBarrier()
      return
    }
    try {
      await windows.hide(note.id)
    } catch {
      setWindowError('便签无法隐藏，请重试。')
    } finally {
      sourceRef.current?.endEditBarrier()
    }
  }, [autosave.flush, note.id, windows])

  useEffect(() => {
    if (windows.onCloseRequested === undefined) return
    let unlisten: (() => void) | undefined
    let disposed = false
    void windows.onCloseRequested((payload) => {
      if (shouldHandleTemporaryClose(note.id, { payload })) void hideAfterFlush()
    }).then((stop) => {
      if (disposed) stop()
      else unlisten = stop
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [hideAfterFlush, windows])

  const togglePin = async () => {
    setWindowError(null)
    try {
      const authoritative = await windows.setAlwaysOnTop(
        note.id,
        !windowState.alwaysOnTop,
      )
      setWindowState(authoritative)
    } catch {
      setWindowError('无法更新置顶状态。')
    }
  }

  return (
    <main data-testid="sticky-window" className="sticky-window">
      <header className="sticky-window__toolbar">
        <button
          type="button"
          data-testid="sticky-drag-region"
          className="sticky-window__drag"
          aria-label="拖动便签"
          onPointerDown={() => void windows.startDragging()}
        >
          <span aria-hidden="true">⋮⋮</span>
          <span>临时便签</span>
        </button>
        <div className="sticky-window__actions">
          <button
            type="button"
            aria-label="钉在桌面上"
            aria-pressed={windowState.alwaysOnTop}
            onClick={() => void togglePin()}
          >
            <span aria-hidden="true">⌖</span>
          </button>
          <button type="button" aria-label="关闭便签" onClick={() => void hideAfterFlush()}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </header>
      <section className="sticky-window__editor" aria-label="便签内容">
        <MarkdownSource
          ref={sourceRef}
          markdown={autosave.markdown}
          onChange={autosave.updateMarkdown}
          noteId={note.id}
          assets={assets}
          onImageError={(message) => setWindowError(message)}
        />
      </section>
      <footer className="sticky-window__status">
        <StickySaveStatus state={autosave.state} />
        {windowError && <span role="alert">{windowError}</span>}
      </footer>
    </main>
  )
}

export function shouldHandleTemporaryClose(
  noteId: NoteDocument['id'],
  event: { payload: unknown },
): boolean {
  return event.payload === noteId
}

function StickySaveStatus({ state }: { state: SaveState }) {
  const notice: StatusNoticeState = state.status === 'idle'
    ? { status: 'status', message: '已就绪' }
    : state.status === 'error'
      ? state
      : {
          status: state.status === 'saved' ? 'success' : 'status',
          message: { dirty: '待保存', saving: '保存中…', saved: '已保存' }[state.status],
        }
  return <StatusNotice state={notice} className={state.status === 'error' ? 'sticky-window__error' : undefined} />
}
