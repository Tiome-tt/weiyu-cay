import { useEffect, useState } from 'react'
import type { NoteId, NoteSummary } from '../../domain/model'
import type { LinkPort } from '../../domain/ports'
import { displayInternalLinks } from './internalLinks'

interface BacklinksProps {
  noteId: NoteId
  links: Pick<LinkPort, 'backlinks'>
  onNavigate(noteId: NoteId): void | Promise<void>
}

type BacklinkState =
  | { status: 'loading' }
  | { status: 'ready'; items: NoteSummary[] }
  | { status: 'error' }

export function Backlinks({ noteId, links, onNavigate }: BacklinksProps) {
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
  }, [links, noteId])

  const count = state.status === 'ready' ? state.items.length : null
  return (
    <section className="backlinks" aria-label="Backlinks">
      <button
        type="button"
        className="backlinks__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        Backlinks{count === null ? '' : ` (${count})`}
      </button>
      {expanded && state.status === 'loading' && <p role="status">Loading backlinks…</p>}
      {expanded && state.status === 'error' && <p role="alert">Could not load backlinks.</p>}
      {expanded && state.status === 'ready' && state.items.length === 0 && <p>No backlinks</p>}
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
