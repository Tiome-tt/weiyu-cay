import { syntaxTree } from '@codemirror/language'
import { EditorSelection, StateEffect, type EditorState, type Extension, type Range, type SelectionRange } from '@codemirror/state'
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { DocumentImageWidget, DocumentTableWidget, type DocumentImageWidgetContext } from './documentWidgets'
import { isTableMetadataLine, parseMarkdownTable, type MarkdownTable } from './markdownActions'

export type LiveMarkdownKind =
  | 'heading'
  | 'strong'
  | 'emphasis'
  | 'strikethrough'
  | 'inline-code'
  | 'link'
  | 'list-marker'
  | 'task-marker'
  | 'quote-marker'
  | 'divider'
  | 'fenced-code'
  | 'image'
  | 'table'

export interface LiveMarkdownNode {
  kind: LiveMarkdownKind
  from: number
  to: number
  contentFrom: number
  contentTo: number
  blockFrom: number
  blockTo: number
  metadata?: Readonly<Record<string, string | number | boolean | null>>
}

export interface LiveMarkdownRange {
  from: number
  to: number
}

export function analyzeLiveMarkdown(
  state: EditorState,
  ranges: readonly LiveMarkdownRange[],
): readonly LiveMarkdownNode[] {
  const result: LiveMarkdownNode[] = []
  const source = state.doc.toString()

  const visit = (node: SyntaxNode) => {
    if (node.name !== 'Document' && !ranges.some((range) => node.from < range.to && node.to > range.from)) return
    const mapped = mapSyntaxNode(state, source, node)
    if (mapped !== null) result.push(mapped)
    if (mapped?.kind === 'image' || mapped?.kind === 'table' || mapped?.kind === 'fenced-code') return
    for (let child = node.firstChild; child !== null; child = child.nextSibling) visit(child)
  }

  visit(syntaxTree(state).topNode)
  return result.sort((left, right) => left.from - right.from || right.to - left.to)
}

export function isLiveNodeActive(node: LiveMarkdownNode, selection: SelectionRange): boolean {
  // Tables own their editing surface in document mode. Keeping the widget
  // mounted prevents a source selection from exposing the persisted pipes,
  // separators, or Cay merge metadata when a table cell is focused.
  if (node.kind === 'table') return false
  return selection.empty
    ? selection.head > node.from && selection.head < node.to
    : selection.from < node.to && selection.to > node.from
}

export function visibleDocumentLineNumbers(
  state: EditorState,
  ranges: readonly LiveMarkdownRange[],
  activeLine: number,
) {
  const numbers = new Set<number>([Math.max(1, Math.min(activeLine, state.doc.lines))])
  for (const range of ranges) {
    const from = Math.max(0, Math.min(range.from, state.doc.length))
    const boundedTo = Math.max(from, Math.min(range.to, state.doc.length))
    const to = boundedTo > from ? boundedTo - 1 : boundedTo
    const first = state.doc.lineAt(from).number
    const last = state.doc.lineAt(to).number
    for (let number = first; number <= last; number += 1) numbers.add(number)
  }
  return [...numbers].sort((left, right) => left - right)
}

function mapSyntaxNode(state: EditorState, source: string, node: SyntaxNode): LiveMarkdownNode | null {
  const line = state.doc.lineAt(node.from)
  const ordinaryBlock = { blockFrom: line.from, blockTo: line.to }
  if (/^ATXHeading[1-6]$/u.test(node.name)) {
    const marker = childNamed(node, 'HeaderMark')
    const afterMarker = marker?.to ?? node.from
    const contentFrom = skipHorizontalWhitespace(source, afterMarker, node.to)
    return liveNode('heading', node.from, node.to, contentFrom, node.to, ordinaryBlock)
  }
  if (node.name === 'StrongEmphasis') return delimitedNode('strong', node, 2, ordinaryBlock)
  if (node.name === 'Emphasis') return delimitedNode('emphasis', node, 1, ordinaryBlock)
  if (node.name === 'Strikethrough') return delimitedNode('strikethrough', node, 2, ordinaryBlock)
  if (node.name === 'InlineCode') return delimitedNode('inline-code', node, 1, ordinaryBlock)
  if (node.name === 'Link') return linkNode(source, node, ordinaryBlock, false)
  if (node.name === 'Image') return linkNode(source, node, ordinaryBlock, true)
  if (node.name === 'ListMark') {
    return liveNode('list-marker', node.from, node.to, node.to, node.to, ordinaryBlock, {
      marker: source.slice(node.from, node.to),
    })
  }
  if (node.name === 'TaskMarker') {
    return liveNode('task-marker', node.from, node.to, node.from, node.to, ordinaryBlock, {
      checked: /x/iu.test(source.slice(node.from, node.to)),
      label: source.slice(node.to, line.to).trim(),
    })
  }
  if (node.name === 'QuoteMark') {
    return liveNode('quote-marker', node.from, node.to, node.to, node.to, ordinaryBlock)
  }
  if (node.name === 'HorizontalRule') {
    return liveNode('divider', node.from, node.to, node.from, node.to, ordinaryBlock)
  }
  if (node.name === 'FencedCode') {
    const code = childNamed(node, 'CodeText')
    const info = childNamed(node, 'CodeInfo')
    return liveNode(
      'fenced-code',
      node.from,
      node.to,
      code?.from ?? node.from,
      code?.to ?? node.from,
      { blockFrom: node.from, blockTo: node.to },
      { language: info === null ? '' : source.slice(info.from, info.to) },
    )
  }
  if (node.name === 'Table') {
    return liveNode('table', node.from, node.to, node.from, node.to, { blockFrom: node.from, blockTo: node.to })
  }
  return null
}

function delimitedNode(
  kind: Extract<LiveMarkdownKind, 'strong' | 'emphasis' | 'strikethrough' | 'inline-code'>,
  node: SyntaxNode,
  delimiterLength: number,
  block: Pick<LiveMarkdownNode, 'blockFrom' | 'blockTo'>,
) {
  return liveNode(kind, node.from, node.to, node.from + delimiterLength, node.to - delimiterLength, block)
}

function linkNode(
  source: string,
  node: SyntaxNode,
  block: Pick<LiveMarkdownNode, 'blockFrom' | 'blockTo'>,
  image: boolean,
): LiveMarkdownNode | null {
  const marks = childrenNamed(node, 'LinkMark')
  const url = childNamed(node, 'URL')
  if (marks.length < 4 || url === null) return null
  const labelOpen = marks[0]
  const labelClose = marks[1]
  const destination = source.slice(url.from, url.to)
  if (image) {
    if (!/^assets\/[A-Za-z0-9._/-]+$/u.test(destination) || destination.includes('..')) return null
    return liveNode('image', node.from, node.to, labelOpen.to, labelClose.from, block, {
      alt: source.slice(labelOpen.to, labelClose.from),
      relativePath: destination,
    })
  }
  return liveNode('link', node.from, node.to, labelOpen.to, labelClose.from, block, { href: destination })
}

function liveNode(
  kind: LiveMarkdownKind,
  from: number,
  to: number,
  contentFrom: number,
  contentTo: number,
  block: Pick<LiveMarkdownNode, 'blockFrom' | 'blockTo'>,
  metadata?: LiveMarkdownNode['metadata'],
): LiveMarkdownNode {
  return { kind, from, to, contentFrom, contentTo, ...block, ...(metadata === undefined ? {} : { metadata }) }
}

function childNamed(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === name) return child
  }
  return null
}

function childrenNamed(node: SyntaxNode, name: string): SyntaxNode[] {
  const children: SyntaxNode[] = []
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === name) children.push(child)
  }
  return children
}

function skipHorizontalWhitespace(source: string, from: number, to: number) {
  let cursor = from
  while (cursor < to && (source[cursor] === ' ' || source[cursor] === '\t')) cursor += 1
  return cursor
}

export type DocumentLineKind =
  | 'blank'
  | 'paragraph'
  | 'heading'
  | 'quote'
  | 'task'
  | 'list'
  | 'divider'
  | 'code-fence'
  | 'code'

export interface DocumentLineClassification {
  kind: DocumentLineKind
  level: number | null
  nextInFence: boolean
  hiddenPrefixLength: number
}

export function classifyDocumentLine(text: string, inFence: boolean): DocumentLineClassification {
  if (/^ {0,3}(?:```|~~~)/.test(text)) {
    return classification('code-fence', !inFence)
  }
  if (inFence) return classification('code', true)
  if (text.trim().length === 0) return classification('blank', false)

  const heading = /^( {0,3})(#{1,6})[\t ]+/.exec(text)
  if (heading !== null) {
    return {
      kind: 'heading',
      level: heading[2].length,
      nextInFence: false,
      hiddenPrefixLength: heading[0].length,
    }
  }

  const quote = /^( {0,3})>[\t ]+/.exec(text)
  if (quote !== null) return classification('quote', false, quote[0].length)

  const task = /^( {0,3})[-+*][\t ]+\[[ xX]\][\t ]+/.exec(text)
  if (task !== null) return classification('task', false, task[0].length)

  const list = /^( {0,3})(?:[-+*]|\d+[.)])[\t ]+/.exec(text)
  if (list !== null) return classification('list', false, list[0].length)

  if (/^ {0,3}(?:(?:\*[\t ]*){3,}|(?:-[\t ]*){3,}|(?:_[\t ]*){3,})$/.test(text)) {
    return classification('divider', false)
  }

  return classification('paragraph', false)
}

function classification(
  kind: DocumentLineKind,
  nextInFence: boolean,
  hiddenPrefixLength = 0,
): DocumentLineClassification {
  return { kind, level: null, nextInFence, hiddenPrefixLength }
}

export type MarkdownPresentation = 'document' | 'source'

export interface DocumentMarkdownExtensionOptions {
  getPresentation(): MarkdownPresentation
  isEditable?(): boolean
  getImageContext?(): DocumentImageWidgetContext
  onEditTable?(input: { from: number; to: number; table: MarkdownTable }): void
}

export const refreshDocumentMarkdownContext = StateEffect.define<void>()

export function createDocumentMarkdownExtension(options: DocumentMarkdownExtensionOptions): Extension {
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildDocumentDecorations(
        view,
        options.getPresentation(),
        options.isEditable?.() ?? true,
        options.getImageContext?.() ?? {},
        options.onEditTable,
      )
    }

    update(update: ViewUpdate) {
      const contextChanged = update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(refreshDocumentMarkdownContext)),
      )
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged || contextChanged) {
        this.decorations = buildDocumentDecorations(
          update.view,
          options.getPresentation(),
          options.isEditable?.() ?? true,
          options.getImageContext?.() ?? {},
          options.onEditTable,
        )
      }
    }
  }, { decorations: (value) => value.decorations })
  return [
    plugin,
    keymap.of([
      { key: 'Delete', run: (view) => handleAtomicWidgetDelete(view, 'forward') },
      { key: 'Backspace', run: (view) => handleAtomicWidgetDelete(view, 'backward') },
    ]),
  ]
}

export const documentMarkdownExtension = createDocumentMarkdownExtension({
  getPresentation: () => 'document',
})

function buildDocumentDecorations(
  view: EditorView,
  presentation: MarkdownPresentation,
  editable: boolean,
  imageContext: DocumentImageWidgetContext,
  onEditTable: DocumentMarkdownExtensionOptions['onEditTable'],
) {
  const ranges: Range<Decoration>[] = []
  if (presentation === 'source') return Decoration.none
  const activeLine = view.state.doc.lineAt(view.state.selection.main.head).number
  const visibleRanges = [...view.visibleRanges]
  const active = view.state.doc.line(activeLine)
  if (!visibleRanges.some((range) => active.from < range.to && active.to > range.from)) {
    visibleRanges.push({ from: active.from, to: active.to })
  }
  const liveNodes = analyzeLiveMarkdown(view.state, visibleRanges)
  const fencedBlocks = liveNodes.filter((node) => node.kind === 'fenced-code')
  for (const number of visibleDocumentLineNumbers(view.state, visibleRanges, activeLine)) {
    const line = view.state.doc.line(number)
    const fence = fencedBlocks.find((node) => line.from >= node.blockFrom && line.to <= node.blockTo)
    const classification = fence === undefined
      ? classifyDocumentLine(line.text, false)
      : classifyDocumentLine(line.text, number !== view.state.doc.lineAt(fence.blockFrom).number)
    const classes = [`cm-document-${classification.kind}`]
    if (classification.kind === 'heading' && classification.level !== null) {
      classes.push(`cm-document-heading-${classification.level}`)
    }
    ranges.push(Decoration.line({ attributes: { class: classes.join(' ') } }).range(line.from))
  }
  for (const node of liveNodes) {
    const activeNode = isLiveNodeActive(node, view.state.selection.main)
    const className = liveContentClass(node.kind)
    if (className !== null && node.contentFrom < node.contentTo) {
      const href = node.kind === 'link' && typeof node.metadata?.href === 'string' ? node.metadata.href : null
      ranges.push(Decoration.mark({
        class: className,
        ...(href === null ? {} : { attributes: { 'data-live-href': href, title: href } }),
      }).range(node.contentFrom, node.contentTo))
    }
    if (activeNode) continue
    if (node.kind === 'image') {
      ranges.push(Decoration.replace({
        widget: new DocumentImageWidget(
          node.from,
          node.to,
          typeof node.metadata?.alt === 'string' ? node.metadata.alt : '',
          typeof node.metadata?.relativePath === 'string' ? node.metadata.relativePath : '',
          imageContext,
        ),
      }).range(node.from, node.to))
    } else if (node.kind === 'table') {
      const tableRange = documentTableSourceRange(view.state, node.from, node.to)
      const source = view.state.doc.sliceString(tableRange.from, tableRange.to)
      const table = parseMarkdownTable(source)
      if (table === null) continue
      const firstLine = view.state.doc.lineAt(tableRange.from)
      const lastLine = view.state.doc.lineAt(Math.max(tableRange.from, tableRange.to - 1))
      ranges.push(Decoration.replace({
        widget: new DocumentTableWidget(tableRange.from, tableRange.to, source, table, onEditTable ?? (() => undefined), editable),
      }).range(firstLine.from, firstLine.to))
      for (let lineNumber = firstLine.number + 1; lineNumber <= lastLine.number; lineNumber += 1) {
        const line = view.state.doc.line(lineNumber)
        ranges.push(Decoration.line({ attributes: { class: 'cm-live-table-continuation' } }).range(line.from))
        addReplacement(ranges, line.from, line.to)
      }
    } else if (node.kind === 'heading' || isDelimitedInline(node.kind) || node.kind === 'link') {
      addReplacement(ranges, node.from, node.contentFrom)
      addReplacement(ranges, node.contentTo, node.to)
    } else if (node.kind === 'list-marker') {
      const taskLine = liveNodes.some((candidate) =>
        candidate.kind === 'task-marker' && candidate.blockFrom === node.blockFrom && candidate.blockTo === node.blockTo)
      if (!taskLine) {
        const marker = typeof node.metadata?.marker === 'string' ? node.metadata.marker : '-'
        ranges.push(Decoration.replace({ widget: new ListMarkerWidget(marker) }).range(node.from, node.to))
      } else {
        addReplacement(ranges, node.from, node.to)
      }
    } else if (node.kind === 'quote-marker') {
      addReplacement(ranges, node.from, node.to)
    } else if (node.kind === 'task-marker') {
      ranges.push(Decoration.replace({
        widget: new TaskCheckboxWidget(
          node.from,
          node.to,
          node.metadata?.checked === true,
          typeof node.metadata?.label === 'string' ? node.metadata.label : '',
        ),
      }).range(node.from, node.to))
    } else if (node.kind === 'divider') {
      ranges.push(Decoration.replace({ widget: new DividerWidget() }).range(node.from, node.to))
    } else if (node.kind === 'fenced-code') {
      const openingLine = view.state.doc.lineAt(node.from)
      const closingLine = view.state.doc.lineAt(Math.max(node.from, node.to - 1))
      ranges.push(Decoration.line({ attributes: { class: 'cm-live-hidden-fence' } }).range(openingLine.from))
      addReplacement(ranges, node.from, openingLine.to)
      if (closingLine.number !== openingLine.number) {
        ranges.push(Decoration.line({ attributes: { class: 'cm-live-hidden-fence' } }).range(closingLine.from))
        addReplacement(ranges, closingLine.from, node.to)
      }
    }
  }

  return Decoration.set(ranges, true)
}

function documentTableSourceRange(state: EditorState, from: number, to: number): { from: number; to: number } {
  let end = to
  const tableLine = state.doc.lineAt(Math.max(from, to - 1))
  const nextLineNumber = tableLine.number + 1
  if (nextLineNumber <= state.doc.lines) {
    const nextLine = state.doc.line(nextLineNumber)
    if (isTableMetadataLine(nextLine.text)) end = nextLine.to
  }
  return { from, to: end }
}

function liveContentClass(kind: LiveMarkdownKind): string | null {
  if (kind === 'strong') return 'cm-live-strong'
  if (kind === 'emphasis') return 'cm-live-emphasis'
  if (kind === 'strikethrough') return 'cm-live-strikethrough'
  if (kind === 'inline-code') return 'cm-live-inline-code'
  if (kind === 'link') return 'cm-live-link'
  return null
}

function isDelimitedInline(kind: LiveMarkdownKind) {
  return kind === 'strong' || kind === 'emphasis' || kind === 'strikethrough' || kind === 'inline-code'
}

function addReplacement(ranges: Range<Decoration>[], from: number, to: number) {
  if (from < to) ranges.push(Decoration.replace({}).range(from, to))
}

class TaskCheckboxWidget extends WidgetType {
  constructor(
    _from: number,
    _to: number,
    private readonly checked: boolean,
    private readonly label: string,
  ) {
    super()
  }

  eq(other: TaskCheckboxWidget) {
    return this.checked === other.checked && this.label === other.label
  }

  toDOM(view: EditorView) {
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.className = 'cm-live-task-checkbox'
    checkbox.checked = this.checked
    checkbox.setAttribute('aria-label', this.checked
      ? `标记任务“${this.label}”为未完成`
      : `标记任务“${this.label}”为完成`)
    checkbox.addEventListener('change', () => {
      const from = view.posAtDOM(checkbox)
      view.dispatch({ changes: { from: from + 1, to: from + 2, insert: checkbox.checked ? 'x' : ' ' } })
      view.focus()
    })
    return checkbox
  }

  ignoreEvent() {
    return false
  }
}

class DividerWidget extends WidgetType {
  toDOM() {
    const divider = document.createElement('span')
    divider.className = 'cm-live-divider'
    divider.setAttribute('role', 'separator')
    divider.setAttribute('aria-label', '分隔线')
    return divider
  }
}

class ListMarkerWidget extends WidgetType {
  constructor(private readonly sourceMarker: string) {
    super()
  }

  eq(other: ListMarkerWidget) {
    return this.sourceMarker === other.sourceMarker
  }

  toDOM() {
    const marker = document.createElement('span')
    marker.className = 'cm-live-list-marker'
    marker.setAttribute('aria-hidden', 'true')
    marker.textContent = /^\d/u.test(this.sourceMarker) ? this.sourceMarker : '•'
    return marker
  }
}

function handleAtomicWidgetDelete(view: EditorView, direction: 'forward' | 'backward') {
  const selection = view.state.selection.main
  const nodes = analyzeLiveMarkdown(view.state, [{ from: 0, to: view.state.doc.length }])
    .filter((node) => node.kind === 'image' || node.kind === 'table')
  const exact = nodes.find((node) => node.from === selection.from && node.to === selection.to)
  if (exact !== undefined) {
    view.dispatch({
      changes: { from: exact.from, to: exact.to },
      selection: EditorSelection.cursor(exact.from),
    })
    return true
  }
  if (!selection.empty) return false
  const adjacent = nodes.find((node) => direction === 'forward'
    ? node.from === selection.head
    : node.to === selection.head)
  if (adjacent === undefined) return false
  view.dispatch({ selection: EditorSelection.range(adjacent.from, adjacent.to) })
  return true
}
