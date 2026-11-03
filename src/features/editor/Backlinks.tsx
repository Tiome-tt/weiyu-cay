import {text as uiText} from '../../shared/i18n'
import { ErrorNotification } from '../../shared/notifications'
import { useEffect, useRef, useState } from 'react'
import {RelatedGraph} from './RelatedGraph'
import type { NoteId, NoteSummary } from '../../domain/model'
import type { LinkPort } from '../../domain/ports'
import { displayInternalLinks } from './internalLinks'

interface BacklinksProps {
  noteId: NoteId
  noteTitle?:string
  links: Pick<LinkPort, 'backlinks'|'neighborhood'>
  onNavigate(noteId: NoteId): void | Promise<void>
  /** Increment after a local save so the panel reflects newly indexed references. */
  refreshToken?: string | number
}

type BacklinkState =
  | { status: 'loading' }
  | { status: 'ready'; items: NoteSummary[] }
  | { status: 'error' }

export function Backlinks({ noteId, noteTitle=uiText("当前笔记","Current note"),links, onNavigate, refreshToken = 0 }: BacklinksProps) {
  const [ratio,setRatio]=useState(50)
  const root=useRef<HTMLDivElement>(null)
  const dragging=useRef(false)
  const resize=(value:number)=>setRatio(Math.max(25,Math.min(75,value)))
  const [expanded, setExpanded] = useState(true)
  const [state, setState] = useState<BacklinkState>({ status: 'loading' })

  useEffect(() => {
    let current = true
    setState({ status: 'loading' })
    void links.backlinks(noteId).then(
      (items) => {
        if (current) setState({ status: 'ready', items })
      },
      () => {
        if (current) setState({ status: 'error' })
      },
    )
    return () => {
      current = false
    }
  }, [links, noteId, refreshToken])

  const count = state.status === 'ready' ? state.items.length : null
  return (
    <div className="related-notes" ref={root} style={{gridTemplateColumns:`minmax(0,${ratio}fr) 1px minmax(0,${100-ratio}fr)`}}>
    <section className="backlinks" aria-label={uiText("引用此笔记","References to this note")}>
      <button
        type="button"
        className="backlinks__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >{uiText("引用此笔记","References to this note")}{count === null ? '' : ` (${count})`}
      </button>
      {expanded && state.status === 'loading' && <p role="status">{uiText("正在加载引用…","Loading references…")}</p>}
      <ErrorNotification error={expanded && state.status === "error" ? uiText("无法加载引用。","Could not load references.") : null} />
      {expanded && state.status === 'ready' && state.items.length === 0 && <p>{uiText("暂无引用","No references yet")}</p>}
      {expanded && state.status === 'ready' && state.items.length > 0 && (
        <ul className="backlinks__list">
          {state.items.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => void onNavigate(item.id)}>
                <strong>{item.title}</strong>
                {item.excerpt && <span>{displayInternalLinks(item.excerpt)}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
    <div role="separator" className="related-notes__divider" aria-label={uiText("调整引用列表与图谱宽度","Resize reference list and graph")} aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={ratio} tabIndex={0}
      onDoubleClick={()=>resize(50)} onPointerDown={event=>{event.preventDefault();event.currentTarget.focus();dragging.current=true;event.currentTarget.setPointerCapture(event.pointerId)}}
      onPointerMove={event=>{const bounds=root.current?.getBoundingClientRect();if(dragging.current&&bounds&&bounds.width>0)resize((event.clientX-bounds.left)/bounds.width*100)}}
      onPointerUp={event=>{dragging.current=false;event.currentTarget.releasePointerCapture(event.pointerId)}} onPointerCancel={()=>{dragging.current=false}} onLostPointerCapture={()=>{dragging.current=false}}
      onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();resize(event.key==='Home'?25:event.key==='End'?75:ratio+(event.key==='ArrowLeft'?-5:5))}}}/>
    <RelatedGraph noteId={noteId} noteTitle={noteTitle} links={links} onNavigate={onNavigate} refreshToken={refreshToken}/>
    </div>
  )
}
