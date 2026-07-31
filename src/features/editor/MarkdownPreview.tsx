import { forwardRef, useMemo } from 'react'
import { renderMarkdown } from './markdownPipeline'

interface MarkdownPreviewProps {
  markdown: string
  onScroll?(): void
}

export const MarkdownPreview = forwardRef<HTMLElement, MarkdownPreviewProps>(
  function MarkdownPreview({ markdown, onScroll }, ref) {
    const html = useMemo(() => renderMarkdown(markdown), [markdown])
    return (
      <article
        ref={ref}
        className="markdown-preview"
        onScroll={onScroll}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  },
)
