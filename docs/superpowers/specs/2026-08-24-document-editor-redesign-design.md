# Cay (微屿) live Markdown document editor redesign

Date: 2026-08-24
Status: Approved

## Goal

Make the default note experience behave like a polished document editor while keeping Markdown as the only durable note body and CodeMirror 6 as the only editing engine. The editor should match the hierarchy, density, and directness of the approved concept while retaining 微屿's original warm ivory-and-sage identity.

## Product decisions

- The persisted `source` mode is presented as “文档编辑” and becomes a live Markdown document surface: supported syntax is rendered in place while the same CodeMirror state remains editable.
- `split` remains “分栏校对” and exposes complete Markdown source beside rendered preview. `preview` remains “阅读视图”. Persisted `EditorMode` values do not change.
- Markdown, image assets, and existing frontmatter remain durable content. There is no block JSON, HTML shadow body, or second editor model.
- CodeMirror transactions remain the sole mutation path for typing, formatting, task toggles, table replacement, image deletion, undo, and redo.
- The supported live-document set is headings, paragraphs, strong emphasis, emphasis, GFM strikethrough, inline code, standard links, internal links, ordered and unordered lists, task lists, blockquotes, fenced code, dividers, GFM tables, and owned local images.
- Incomplete, malformed, unsupported, raw-HTML, or unsafe constructs remain visible source. The display layer never silently normalizes, removes, or rewrites them.
- The metadata title remains the large document title and continues to use the existing typed rename action. It sits in a distinct document header above the body with a localized “最后编辑于” timestamp sourced from the latest authoritative save.
- No second editor, state, database, styling, or component framework is added.

## Editing model

### Local reveal

- Supported Markdown renders without punctuation when the selection is outside its syntax node.
- Entering or selecting a syntax node reveals the smallest complete source range needed to edit it. Other nodes stay rendered.
- Incomplete syntax stays source until the parser recognizes a complete construct, preventing decorations from fighting unfinished input.
- Leaving the node returns it to rendered presentation without mutating the Markdown.
- “分栏校对” is the permanent complete-source escape hatch for precise editing and unsupported content.

### Inline content

- `**strong**`, `*emphasis*`, `~~strikethrough~~`, and inline code display formatted text without delimiters while inactive. Their complete delimiters reappear when active.
- Standard links display their label with link styling rather than `[label](destination)`. Hover or keyboard focus exposes the destination; `Ctrl/Cmd + click` invokes the existing explicit external-link boundary.
- Internal links keep their existing atomic `[[Visible title]]` presentation, hidden UUID, resolution state, navigation contract, and two-step deletion behavior.
- The selection toolbar applies only Markdown-compatible transformations through CodeMirror transactions and restores a deliberate selection or caret.

### Block content

- Headings display at their semantic level without `#` markers while inactive.
- Ordered and unordered lists display visual markers; task items display interactive checkboxes. Toggling a checkbox changes only `[ ]` or `[x]` through a CodeMirror transaction.
- Blockquotes display as restrained sage callouts without visible `>` markers while inactive.
- Dividers display as quiet rules without their source characters while inactive.
- Fenced code displays as a code block with an optional language label. Fence lines and the language declaration reappear when the selection enters that code block; code content itself stays literal.
- A quiet block handle follows the active block from a dedicated gutter to the left of the text column and opens the existing Markdown insertion actions. It never overlays body text, including at narrow widths.

### Images

- A valid owned image reference such as `![Alt](assets/...)` displays the image directly inside the document measure.
- The image widget obtains bytes only through the existing typed asset port and owned-path validation. It creates and revokes object URLs with the widget lifecycle and never reads arbitrary renderer paths.
- Missing or unreadable images display a stable placeholder containing the alternative text and a clear “找不到图片” state instead of exposing only the asset path.
- A click or keyboard focus selects the whole image source range. Enter opens an accessible metadata action for alternative text and the owned asset reference. Backspace/Delete uses atomic selection before deletion and remains undoable.
- Pasted images continue through the existing save-image flow and become widgets only after the Markdown reference is successfully inserted.

### Tables

- A complete GFM table displays as a real table without pipe or separator source while inactive.
- Activating a table opens the existing table editor populated from the table's current cells and alignment metadata. Saving replaces only the original table source range in one transaction.
- Wide tables scroll horizontally inside their own document block. Cursor parking positions before and after the atomic table let keyboard users cross the widget without becoming trapped.
- Malformed tables remain source text.

## Architecture

### Syntax-derived display ranges

- A focused document-syntax module consumes CodeMirror's Markdown syntax tree and produces typed display nodes with stable source ranges, parent ranges, node kind, active state, and data required by widgets.
- Regular expressions may validate a known leaf token or parse a widget's already-bounded source, but they do not determine nested Markdown structure.
- Decoration generation is limited to visible ranges plus the active block and any asynchronous widget whose state changes. Typing in a long document must not rebuild every line.

### Decorations and widgets

- Mark decorations style text that remains in the editable DOM.
- Replace decorations hide delimiters only when the corresponding node is inactive.
- Atomic widgets represent images and tables; task checkboxes use a narrow replacement widget for the marker only.
- Widget callbacks receive typed intents. React and the editor adapter translate those intents into CodeMirror transactions or existing ports; widgets do not access persistence directly.
- Decoration precedence and atomic ranges are explicitly coordinated with the existing internal-link extension so overlapping syntax cannot create invalid ranges or bypass two-step deletion.

### Preservation boundaries

- Autosave continues to receive `view.state.doc.toString()` after document-changing transactions.
- Edit barriers reject unauthorized changes exactly as before, including widget-originated actions.
- Selection, undo history, scroll restoration, navigation-to-line, image-paste ordering, and note-switch generation checks retain their contracts.
- Preview continues to use the existing sanitized unified pipeline and explicit owned-image/external-link handling.

## Layout and visual language

- A quiet 44px document toolbar contains the breadcrumb, save state, secondary actions, and three view controls.
- Title, body, images, tables, and preview align to `--document-measure: 780px` with responsive side padding.
- The document header uses a stronger title scale, quiet last-edited metadata, a subtle separator, and enough breathing room to remain unmistakably separate from the first body block.
- Live editing is the default view for fresh settings; split and preview remain explicit, persisted user choices.
- The primary palette remains surface `#F8FAF7`, text `#263A33`, heading `#172621`, sage `#58A38E`, deep sage `#2F7866`, and restrained warm accent `#D59A5E`.
- Configured body and code fonts remain authoritative; no network font is introduced.
- Warm ivory is the reading surface, sage communicates structure and focus, and warm accent is reserved for small warnings or emphasis.
- The signature interaction is the quiet left-margin “island shore” block handle, which becomes clear on hover, active block, or keyboard focus.
- Borders remain quiet and shadows are limited to floating controls. Gradients, glass effects, oversized cards, and copied third-party assets are excluded.
- The approved concept sets the target for hierarchy, density, and finish, not for copied branding or assets.

## Accessibility and keyboard behavior

- `Ctrl/Cmd+B`, `Ctrl/Cmd+I`, `Ctrl/Cmd+K`, and supported toolbar actions use the same transaction-based formatting commands.
- Images, links, tasks, tables, and floating controls expose meaningful accessible names, visible focus, disabled/read-only state, and keyboard activation.
- Image alternative text becomes its accessible name; an empty alternative marks a decorative image.
- Tab and arrow navigation can enter, activate, and leave atomic widgets. Widgets never trap focus.
- Image, table, and internal-link deletion selects the complete source node before deletion and remains immediately undoable.
- Reduced motion, adequate contrast, narrow-window layout, and configured typography remain required.

## Error and fallback behavior

- An invalid parse, overlapping unsupported construct, missing asset, failed port request, or stale asynchronous result cannot change the Markdown.
- A widget failure falls back to a stable, selectable source or explicit placeholder at the same document location.
- Switching notes invalidates pending image loads and widget actions by note/editor generation.
- Error copy is user-safe and never logs note bodies, tokens, or local absolute paths.

## Verification

Use a deterministic showcase note containing six heading levels, paragraphs, nested inline formatting, standard and internal links, a missing internal link, ordered and unordered lists, tasks, a quote, divider, fenced code, owned and missing images, ordinary and wide tables, escapes, incomplete syntax, and raw HTML.

- Unit-test syntax-tree node extraction, nesting, active-node calculation, delimiter ranges, malformed fallbacks, image references, and table parse/serialize behavior.
- For each supported construct, component-test inactive rendering, local source reveal, and unchanged underlying Markdown.
- Test checkbox, formatting, table replacement, image selection/deletion, undo, keyboard traversal, read-only state, and edit-barrier rejection.
- Test safe image loading, object URL revocation, missing-image fallback, stale asynchronous results, and note switching.
- Keep existing autosave, paste ordering, internal-link two-step deletion, link refresh/navigation, selection, scroll, three-view, and preview sanitization tests passing.
- Add a long-document test proving decoration work is scoped to viewports and the active block.
- Run focused Vitest files, `pnpm typecheck`, the relevant production UI build, and `git diff --check`.
- Perform visual QA at wide and narrow sizes and in at least one dark theme. Compare document hierarchy, formatted Markdown visibility, owned-image rendering, table rendering, focus, and overflow against the approved concept.

## Compatibility and migration

- Existing `.md` files, image paths, frontmatter, SQLite metadata, `EditorMode` values, and settings remain compatible.
- No storage migration is required.
- Unsupported content remains recoverable through source/split editing, so adopting the live document surface cannot make an existing note unreadable or lossy.
