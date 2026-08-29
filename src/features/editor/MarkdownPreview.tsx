import { forwardRef, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import type { NoteId, NoteSummary } from '../../domain/model'
import type { ImageReadPort, LinkPort, SystemPort } from '../../domain/ports'
import {
  markdownWithPreviewLinks,
  resolutionClass,
  resolutionTitle,
} from './internalLinks'
import { renderPreviewMarkdown } from './markdownPipeline'

interface MarkdownPreviewProps {
  markdown: string
  onScroll?(): void
  links?: Pick<LinkPort, 'resolve'>
  linkCache?: ReadonlyMap<NoteId, NoteSummary>
  onNavigateLink?(noteId: NoteId): void
  noteId?: NoteId
  assetReader?: ImageReadPort
  external?: Pick<SystemPort, 'openExternal'>
}

export const MarkdownPreview = forwardRef<HTMLElement, MarkdownPreviewProps>(
  function MarkdownPreview({ markdown, onScroll, links, linkCache, onNavigateLink, noteId, assetReader, external }, ref) {
    const prepared = useMemo(() => {
      const identity = createPreviewIdentity()
      return { ...markdownWithPreviewLinks(markdown, identity), identity }
    }, [markdown])
    const html = useMemo(() => renderPreviewMarkdown(prepared.markdown), [prepared.markdown])
    const [resolutions, setResolutions] = useState<ReadonlyMap<NoteId, NoteSummary | null>>(new Map())
    const [previewZoom, setPreviewZoom] = useState(1)
    const [assetState, setAssetState] = useState<{
      html: string
      urls: ReadonlyMap<string, string>
    }>({ html: '', urls: new Map() })
    const resolvedHtml = useMemo(() => {
      const urls = assetState.html === html ? assetState.urls : new Map<string, string>()
      return html.replace(
        /(<img\b[^>]*data-simple-notes-asset="([^"]+)"[^>]*)(>)/gu,
        (whole, prefix: string, relativePath: string, close: string) => {
          const objectUrl = urls.get(relativePath)
          return objectUrl === undefined ? whole : `${prefix} src="${objectUrl}"${close}`
        },
      )
    }, [assetState, html])
    const articleRef = useRef<HTMLElement | null>(null)

    useEffect(() => {
      let current = true
      const objectUrls: string[] = []
      setAssetState({ html, urls: new Map() })
      if (noteId !== undefined && assetReader !== undefined) {
        const relativePaths = new Set(
          Array.from(html.matchAll(/data-simple-notes-asset="([^"]+)"/gu), (match) => match[1]),
        )
        for (const relativePath of relativePaths) {
          void assetReader.readImage({ noteId, relativePath }).then(
            (loaded) => {
              if (!current) return
              try {
                const objectUrl = URL.createObjectURL(new Blob([loaded.bytes.slice().buffer], { type: loaded.mediaType }))
                objectUrls.push(objectUrl)
                setAssetState((state) => state.html === html
                  ? { html, urls: new Map(state.urls).set(relativePath, objectUrl) }
                  : state)
              } catch {}
            },
            () => undefined,
          )
        }
      }
      return () => {
        current = false
        for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl)
      }
    }, [assetReader, html, noteId])

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
    }, [prepared.links, resolutions, resolvedHtml])

    const activate = (event: MouseEvent<HTMLElement>) => {
      const element = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a') : null
      const href = element?.getAttribute('href')
      if (element !== null) event.preventDefault()
      const externalUrl = element?.dataset.simpleNotesExternalLink
      if (externalUrl !== undefined) {
        void external?.openExternal(externalUrl)
        return
      }
      const match = href?.match(new RegExp(`^#simple-notes-internal-${prepared.identity}-(\\d+)$`))
      if (match === undefined || match === null) return
      const link = prepared.links[Number(match[1])]
      if (link === undefined || !resolutions.get(link.targetId)) return
      onNavigateLink?.(link.targetId)
    }

    const handleZoom = (event: React.WheelEvent<HTMLElement>) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      setPreviewZoom((value) => Math.min(2, Math.max(0.5, value + (event.deltaY < 0 ? 0.1 : -0.1))))
    }

    const previewStyle = { '--preview-zoom': previewZoom } as CSSProperties

    return (
      <article
        ref={(element) => {
          articleRef.current = element
          if (typeof ref === 'function') ref(element)
          else if (ref !== null) ref.current = element
        }}
        className="markdown-preview"
        style={previewStyle}
        onScroll={onScroll}
        onClick={activate}
        onWheel={handleZoom}
        dangerouslySetInnerHTML={{ __html: resolvedHtml }}
      />
    )
  },
)

function createPreviewIdentity(): string {
  const random = new Uint32Array(4)
  globalThis.crypto.getRandomValues(random)
  return Array.from(random, (value) => value.toString(36)).join('-')
}
