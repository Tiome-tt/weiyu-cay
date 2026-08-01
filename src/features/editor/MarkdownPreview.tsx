import { forwardRef, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { NoteId, NoteSummary } from '../../domain/model'
import type { LinkPort } from '../../domain/ports'
import {
  markdownWithPreviewLinks,
  resolutionClass,
  resolutionTitle,
} from './internalLinks'
import { renderMarkdown } from './markdownPipeline'

interface MarkdownPreviewProps {
  markdown: string
  onScroll?(): void
  links?: Pick<LinkPort, 'resolve'>
  linkCache?: ReadonlyMap<NoteId, NoteSummary>
  onNavigateLink?(noteId: NoteId): void
}

export const MarkdownPreview = forwardRef<HTMLElement, MarkdownPreviewProps>(
  function MarkdownPreview({ markdown, onScroll, links, linkCache, onNavigateLink }, ref) {
    const prepared = useMemo(() => {
      const identity = createPreviewIdentity()
      return { ...markdownWithPreviewLinks(markdown, identity), identity }
    }, [markdown])
    const html = useMemo(() => renderMarkdown(prepared.markdown), [prepared.markdown])
    const [resolutions, setResolutions] = useState<ReadonlyMap<NoteId, NoteSummary | null>>(new Map())
    const articleRef = useRef<HTMLElement | null>(null)

    useEffect(() => {
      let current = true
      const next = new Map<NoteId, NoteSummary | null>()
      const unresolved = new Set<NoteId>()
      for (const link of prepared.links) {
        const cached = linkCache?.get(link.targetId)
        if (cached !== undefined && cached.id === link.targetId) next.set(link.targetId, cached)
        else unresolved.add(link.targetId)
      }
      setResolutions(next)
      if (links !== undefined) {
        for (const targetId of unresolved) {
          void links.resolve(targetId).then(
            (summary) => {
              if (!current) return
              const guarded = summary === null || summary.id === targetId ? summary : null
              setResolutions((value) => new Map(value).set(targetId, guarded))
            },
            () => {
              if (current) setResolutions((value) => new Map(value).set(targetId, null))
            },
          )
        }
      } else {
        for (const targetId of unresolved) next.set(targetId, null)
        setResolutions(next)
      }
      return () => {
        current = false
      }
    }, [linkCache, links, prepared.links])

    useEffect(() => {
      const host = articleRef.current
      if (host === null) return
      prepared.links.forEach((link, index) => {
        const anchor = host.querySelector<HTMLAnchorElement>(
          `a[href="#simple-notes-internal-${prepared.identity}-${index}"]`,
        )
        if (anchor === null) return
        const resolution = resolutions.has(link.targetId) ? resolutions.get(link.targetId) : undefined
        anchor.className = `internal-link internal-link--${resolutionClass(resolution)}`
        anchor.title = resolutionTitle(resolution)
        if (resolution === null) anchor.setAttribute('aria-disabled', 'true')
        else anchor.removeAttribute('aria-disabled')
      })
    }, [html, prepared.links, resolutions])

    const activate = (event: MouseEvent<HTMLElement>) => {
      const element = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a') : null
      const href = element?.getAttribute('href')
      const match = href?.match(new RegExp(`^#simple-notes-internal-${prepared.identity}-(\\d+)$`))
      if (match === undefined || match === null) return
      event.preventDefault()
      const link = prepared.links[Number(match[1])]
      if (link === undefined || !resolutions.get(link.targetId)) return
      onNavigateLink?.(link.targetId)
    }

    return (
      <article
        ref={(element) => {
          articleRef.current = element
          if (typeof ref === 'function') ref(element)
          else if (ref !== null) ref.current = element
        }}
        className="markdown-preview"
        onScroll={onScroll}
        onClick={activate}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  },
)

function createPreviewIdentity(): string {
  const random = new Uint32Array(4)
  globalThis.crypto.getRandomValues(random)
  return Array.from(random, (value) => value.toString(36)).join('-')
}
