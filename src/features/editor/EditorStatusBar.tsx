import {UI_LOCALE} from '../../shared/i18n'
import {text as uiText} from '../../shared/i18n'
import { forwardRef, useImperativeHandle, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { SaveState } from './useAutosave'
import { displayInternalLinks } from './internalLinks'

export function noteStatistics(text: string) {
  const visible = displayInternalLinks(text)
  return { lines: text.length === 0 ? 0 : text.split('\n').length, characters: Array.from(visible.replace(/\s/gu, '')).length }
}
interface Props { blockCount?: number; text: string | null; selectedText?: string; updatedAt: string; state: SaveState; related?: ReactNode }
export interface EditorStatusBarHandle { updateText(text: string): void }
export const EditorStatusBar = forwardRef<EditorStatusBarHandle, Props>(function EditorStatusBar({ text, blockCount, selectedText = '', updatedAt, state, related }, ref) {
  const [liveText, setLiveText] = useState(text)
  const pendingText = useRef(text)
  const frame = useRef<number | null>(null)
  useEffect(() => { pendingText.current = text; if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; setLiveText(text) }, [text])
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current) }, [])
  useImperativeHandle(ref, () => ({updateText: value => {
    pendingText.current = value
    if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; setLiveText(pendingText.current) })
  }}), [])
  const [open, setOpen] = useState(false)
  const [height, setHeight] = useState(200)
  const [previewSelection, setPreviewSelection] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; height: number } | null>(null)
  const panelId = useId()
  useEffect(() => {
    const select = () => {
      const selection = window.getSelection()
      const body = root.current?.parentElement?.querySelector('.editor-document__preview, .typed-editor__body')
      setPreviewSelection(body && selection?.anchorNode && body.contains(selection.anchorNode) && selection.focusNode && body.contains(selection.focusNode) ? selection.toString() : '')
    }
    document.addEventListener('selectionchange', select)
    return () => document.removeEventListener('selectionchange', select)
  }, [])
  const stats = liveText === null ? null : noteStatistics(liveText)
  const selected = noteStatistics(selectedText || previewSelection).characters
  const resize = (value: number) => setHeight(Math.max(72, Math.min(360, value)))
  const date = new Date(updatedAt)
  const edited = Number.isNaN(date.getTime()) ? uiText("时间未知","Unknown time") : new Intl.DateTimeFormat(UI_LOCALE, {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(date)
  const message = { idle: uiText("已保存","Saved"), saved: uiText("已保存","Saved"), dirty: uiText("待保存","Unsaved"), saving: uiText("保存中…","Saving…"), error: uiText("保存失败","Save failed") }[state.status]
  return <div className="editor-status" ref={root}>
    {open && related && <section id={panelId} className="editor-status__related" aria-label={uiText("关联笔记内容","Related notes panel")} style={{height}}>
      <div className="editor-status__resize" role="separator" aria-label={uiText("调整关联笔记高度","Resize related notes height")} aria-orientation="horizontal" aria-valuemin={72} aria-valuemax={360} aria-valuenow={height} tabIndex={0}
        onPointerDown={event => { drag.current={y:event.clientY,height}; event.currentTarget.setPointerCapture(event.pointerId) }}
        onPointerMove={event => { if(drag.current)resize(drag.current.height+drag.current.y-event.clientY) }}
        onPointerUp={event => { drag.current=null; event.currentTarget.releasePointerCapture(event.pointerId) }}
        onPointerCancel={()=>{drag.current=null}}
        onKeyDown={event=>{if(['ArrowUp','ArrowDown','Home','End'].includes(event.key)){event.preventDefault();resize(event.key==='Home'?72:event.key==='End'?360:height+(event.key==='ArrowUp'?24:-24))}}}/>
      <div className="editor-status__related-scroll">{related}</div>
    </section>}
    <footer className="editor-status__bar" aria-label={uiText("笔记状态栏","Note status bar")}>
      <span>{stats ? uiText(`${blockCount ?? stats.lines} 行 · ${stats.characters} 字`,`${blockCount ?? stats.lines} lines · ${stats.characters} characters`) : uiText("— 行 · — 字","— lines · — characters")}{selected > 0 ? uiText(` · 选中 ${selected} 字`,` · Selected ${selected} characters`) : ''}</span>
      {related && <button type="button" aria-label={uiText("关联笔记","Related notes")} title={uiText("关联笔记","Related notes")} aria-expanded={open} aria-controls={panelId} onClick={()=>setOpen(value=>!value)}><svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" aria-hidden="true"><path d="m8 12 4-4m-6 6H5a3 3 0 0 1-2-5l3-3a3 3 0 0 1 4 0m0 8a3 3 0 0 0 4 0l3-3a3 3 0 0 0-2-5h-1"/></svg></button>}
      <span className="editor-status__save"><time dateTime={updatedAt} title={uiText("最后编辑时间","Last edited")}>{edited}</time><span role="status" aria-label={uiText("保存状态","Save status")} className={state.status==='error'?'editor-save--error':''}>{message}</span></span>
    </footer>
  </div>
})
