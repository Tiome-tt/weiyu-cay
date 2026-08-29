import { useEffect, useState } from 'react'
import type { NoteId, NoteSummary } from '../../domain/model'
import type { LinkPort } from '../../domain/ports'
import { displayInternalLinks } from './internalLinks'

interface BacklinksProps {
  noteId: NoteId
  links: Pick<LinkPort, 'backlinks'>
  onNavigate(noteId: NoteId): void | Promise<void>
  /** Increment after a local save so the panel reflects newly indexed references. */
  refreshToken?: string | number
}

type BacklinkState =
  | { status: 'loading' }
  | { status: 'ready'; items: NoteSummary[] }
  | { status: 'error' }

export function Backlinks({ noteId, links, onNavigate, refreshToken = 0 }: BacklinksProps) {
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
    <section className="backlinks" aria-label="引用此笔记">
      <button
        type="button"
        className="backlinks__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        引用此笔记{count === null ? '' : ` (${count})`}
      </button>
      {expanded && state.status === 'loading' && <p role="status">正在加载引用…</p>}
      {expanded && state.status === 'error' && <p role="alert">无法加载引用。</p>}
      {expanded && state.status === 'ready' && state.items.length === 0 && <p>暂无引用</p>}
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
  )
}
