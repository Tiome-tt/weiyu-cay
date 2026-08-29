# Cay (微屿) document editor redesign

Date: 2026-08-24
Status: Approved

## Goal

Make the default note experience feel like a polished document editor while keeping Markdown as the only durable note body. The approved direction combines clear document hierarchy with 微屿's warm ivory-and-sage identity instead of copying Feishu assets or branding.

## Product decisions

- The default persisted `source` mode is presented as “文档编辑”. CodeMirror 6 still edits the Markdown string directly.
- `split` is presented as “分栏校对” and `preview` as “阅读视图”. Persisted `EditorMode` values remain unchanged.
- Markdown, images, and existing frontmatter remain durable content. There is no block JSON or rich-text shadow document.
- The first version supports only constructs that round-trip through the existing Markdown pipeline: headings, paragraphs, emphasis, links, lists, tasks, quotes, code, dividers, tables, images, and internal links.
- Unsupported Markdown stays editable source text and is never silently removed or rewritten.
- The note metadata title is the large document title. Renaming continues through the existing typed domain action.
- Existing insertion actions remain available through context click and a visible block handle. A selection toolbar applies only Markdown-compatible inline formatting.
- No second editor framework is added.

## Layout and visual language

- A quiet 44px document toolbar contains a folder/title breadcrumb, save state, secondary actions, and three view controls.
- Title and body align to a centered reading measure capped near 780px with responsive side padding.
- Body text uses configured typography. Headings, quotes, tasks, code, tables, images, and dividers receive restrained document styling.
- Warm ivory is the reading surface; sage communicates selection and structure; terracotta is reserved for small emphasis and warnings.
- Borders remain quiet and shadows are limited to floating controls. Gradients, glass effects, oversized cards, and copied third-party assets are excluded.
- Focus visibility, keyboard operation, reduced motion, contrast, and narrow-window behavior remain required.

## Editing behavior

- CodeMirror line decorations provide live hierarchy without changing Markdown.
- Heading markers may be hidden away from the active heading and reappear on its active line.
- Selecting text reveals controls for bold, italic, link, inline code, and GFM strikethrough. Actions replace only the selection and restore an intentional selection or caret.
- A block handle follows the active line and opens the existing Markdown insertion menu.
- Autosave, image paste, internal links, scrolling, editing barriers, and navigation retain their contracts.

## Preview behavior

- Preview shares the editor's reading measure and hierarchy.
- Quotes use a sage callout treatment while remaining ordinary blockquotes.
- Tables, task lists, code, images, links, and rules are styled as document content rather than generic browser Markdown.
- Preview HTML remains sanitized and external-link behavior stays explicit.

## Verification

- Unit-test inline Markdown transformations and line classification.
- Component-test the new labels, title placement, block handle, selection formatting, and unchanged underlying Markdown.
- Keep existing view, scroll, link, image, barrier, autosave, and title tests passing.
- Test the shared reading measure and toolbar CSS contracts.
- Run focused editor tests, TypeScript type-check, a production UI build, and visual screenshot inspection.

