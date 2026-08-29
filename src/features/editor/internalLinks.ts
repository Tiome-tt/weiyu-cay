import {
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  type ChangeSet,
  type Extension,
  type Text,
} from '@codemirror/state'
import { history, historyKeymap } from '@codemirror/commands'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import type { NoteId, NoteSummary } from '../../domain/model'
import type { LinkPort } from '../../domain/ports'
import {
  formatStoredLink,
  parseStoredLink,
} from '../../domain/noteFormat'
import { commonmarkProseRanges } from './markdownPipeline'

export interface InternalLinkRange {
  from: number
  to: number
  label: string
  targetId: NoteId
}

export interface InternalLinkExtensionOptions {
  links: Pick<LinkPort, 'resolve'>
  getCached(targetId: NoteId): NoteSummary | undefined
  onNavigate(targetId: NoteId): void
}

type Resolution = NoteSummary | null | undefined

export { escapeInternalLinkLabel } from '../../domain/noteFormat'

export const refreshInternalLinkContext = StateEffect.define<void>()

const internalLinkRangesField = StateField.define<readonly InternalLinkRange[]>({
  create: (state) => parseInternalLinks(state.doc.toString()),
  update: (ranges, transaction) => {
    if (!transaction.docChanged) return ranges
    if (requiresInternalLinkRescan(transaction.changes, transaction.startState.doc, ranges)) {
      return parseInternalLinks(transaction.newDoc.toString())
    }
    return ranges.map((link) => mapInternalLinkRange(transaction.changes, link))
  },
})

export function parseInternalLinks(markdown: string): InternalLinkRange[] {
  if (!markdown.includes('[[')) return []
  const links: InternalLinkRange[] = []
  for (const range of commonmarkProseRanges(markdown)) {
    let cursor = range.from
    while (cursor < range.to) {
      const from = markdown.indexOf('[[', cursor)
      if (from < 0 || from >= range.to) break
      const candidate = scanInternalLinkCandidate(markdown, from)
      if (candidate.kind === 'unterminated') break
      if (candidate.kind === 'nested') {
        cursor = candidate.from
        continue
      }
      const to = candidate.close + 2
      if (to <= range.to && candidate.separators.length === 1) {
        try {
          const parsed = parseStoredLink(markdown.slice(from, to))
          links.push({ from, to, label: parsed.title, targetId: parsed.noteId })
        } catch {
          // Malformed application syntax remains ordinary, untouched Markdown.
        }
      }
      cursor = to
    }
  }
  return links
}

export function serializeInternalLink(target: NoteSummary): string {
  return formatStoredLink(target.title, target.id)
}

export function displayInternalLinks(markdown: string): string {
  const links = parseInternalLinks(markdown)
  let displayed = markdown
  for (let index = links.length - 1; index >= 0; index -= 1) {
    const link = links[index]
    displayed = `${displayed.slice(0, link.from)}[[${link.label}]]${displayed.slice(link.to)}`
  }
  return displayed
}

export function internalLinkExtension(options: InternalLinkExtensionOptions): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      private ranges: InternalLinkRange[] = []
      private readonly resolutions = new Map<NoteId, Resolution>()
      private generation = 0

      constructor(private readonly view: EditorView) {
        this.decorations = this.buildDecorations()
      }

      update(update: ViewUpdate) {
        const contextChanged = update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(refreshInternalLinkContext)),
        )
        if (!update.docChanged && !contextChanged) return
        if (
          update.docChanged &&
          !contextChanged &&
          !requiresInternalLinkRescan(update.changes, update.startState.doc, this.ranges)
        ) {
          this.ranges = [...update.state.field(internalLinkRangesField)]
          this.decorations = this.decorations.map(update.changes)
          return
        }
        this.generation += 1
        const retained = contextChanged ? undefined : new Map(this.resolutions)
        this.resolutions.clear()
        this.decorations = this.buildDecorations(retained, update.state.field(internalLinkRangesField))
      }

      private buildDecorations(
        retained?: ReadonlyMap<NoteId, Resolution>,
        nextRanges: readonly InternalLinkRange[] = this.view.state.field(internalLinkRangesField),
      ) {
        this.ranges = [...nextRanges]
        const ranges = this.ranges
        for (const link of ranges) {
          if (this.resolutions.has(link.targetId)) continue
          const cached = options.getCached(link.targetId)
          if (cached !== undefined && cached.id === link.targetId) {
            this.resolutions.set(link.targetId, cached)
          } else if (retained?.has(link.targetId) && retained.get(link.targetId) !== undefined) {
            this.resolutions.set(link.targetId, retained.get(link.targetId))
          } else {
            this.resolutions.set(link.targetId, undefined)
            this.resolve(link.targetId, this.generation)
          }
        }
        return Decoration.set(
          ranges.map((link) =>
            Decoration.replace({
              inclusive: true,
              widget: new InternalLinkWidget(
                link,
                this.resolutions.get(link.targetId),
                options.onNavigate,
              ),
            }).range(link.from, link.to),
          ),
        )
      }

      private resolve(targetId: NoteId, generation: number) {
        void options.links.resolve(targetId).then(
          (summary) => this.acceptResolution(targetId, summary, generation),
          () => this.acceptResolution(targetId, null, generation),
        )
      }

      private acceptResolution(targetId: NoteId, summary: NoteSummary | null, generation: number) {
        if (generation !== this.generation) return
        if (!parseInternalLinks(this.view.state.doc.toString()).some((link) => link.targetId === targetId)) return
        this.resolutions.set(targetId, summary === null || summary.id === targetId ? summary : null)
        this.decorations = this.buildDecorations()
        this.view.dispatch({})
      }
    },
    { decorations: (value) => value.decorations },
  )

  return [
    internalLinkRangesField,
    history(),
    EditorState.transactionFilter.of((transaction) => {
      if (!transaction.docChanged) return transaction
      const links = transaction.startState.field(internalLinkRangesField)
      let partial = false
      transaction.changes.iterChangedRanges((from, to) => {
        if (partial) return
        partial = links.some((link) => {
          if (from === to) return from > link.from && from < link.to
          const overlaps = from < link.to && to > link.from
          const containsWholeLink = from <= link.from && to >= link.to
          return overlaps && !containsWholeLink
        })
      })
      return partial ? [] : transaction
    }),
    plugin,
    EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
    keymap.of([
      { key: 'Backspace', run: (view) => handleAtomicDelete(view, 'backward') },
      { key: 'Delete', run: (view) => handleAtomicDelete(view, 'forward') },
      ...historyKeymap,
    ]),
  ]
}

function containsLinkSyntax(value: string) {
  return /[\[\]|\\]/u.test(value)
}

function rangesTouch(link: InternalLinkRange, from: number, to: number) {
  return from <= link.to && to >= link.from
}

function requiresInternalLinkRescan(
  changes: ChangeSet,
  startDoc: Text,
  ranges: readonly InternalLinkRange[],
) {
  let changed = false
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (changed) return
    const deleted = startDoc.sliceString(fromA, toA)
    const insertedText = inserted.toString()
    const linePrefixChanged = fromA - startDoc.lineAt(Math.min(fromA, startDoc.length)).from < 4
    if (
      containsLinkSyntax(insertedText) ||
      containsLinkSyntax(deleted) ||
      insertedText.includes('\n') ||
      deleted.includes('\n') ||
      linePrefixChanged ||
      ranges.some((link) => rangesTouch(link, fromA, toA))
    ) {
      changed = true
    }
  })
  return changed
}

function mapInternalLinkRange(changes: ChangeSet, link: InternalLinkRange): InternalLinkRange {
  return {
    ...link,
    from: changes.mapPos(link.from, 1),
    to: changes.mapPos(link.to, -1),
  }
}

export function insertInternalLink(view: EditorView, target: NoteSummary): boolean {
  const selection = view.state.selection.main
  const insert = serializeInternalLink(target)
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: EditorSelection.cursor(selection.from + insert.length),
  })
  return true
}

export function retargetInternalLink(view: EditorView, target: NoteSummary): boolean {
  const selection = view.state.selection.main
  const link = parseInternalLinks(view.state.doc.toString()).find((candidate) =>
    selection.empty
      ? selection.head >= candidate.from && selection.head <= candidate.to
      : selection.from <= candidate.to && selection.to >= candidate.from,
  )
  if (link === undefined) return false
  const replacement = serializeInternalLink(target)
  view.dispatch({
    changes: { from: link.from, to: link.to, insert: replacement },
    selection: EditorSelection.cursor(link.from + replacement.length),
  })
  return true
}

function handleAtomicDelete(view: EditorView, direction: 'backward' | 'forward'): boolean {
  const selection = view.state.selection.main
  const links = parseInternalLinks(view.state.doc.toString())
  const exact = links.find((link) => link.from === selection.from && link.to === selection.to)
  if (exact !== undefined) {
    view.dispatch({ changes: { from: exact.from, to: exact.to }, selection: EditorSelection.cursor(exact.from) })
    return true
  }
  const overlap = links.find((link) => selection.from < link.to && selection.to > link.from)
  if (overlap !== undefined) {
    view.dispatch({
      selection: EditorSelection.range(
        Math.min(selection.from, overlap.from),
        Math.max(selection.to, overlap.to),
      ),
    })
    return true
  }
  if (!selection.empty) return false
  const adjacent = links.find((link) =>
    direction === 'backward' ? link.to === selection.head : link.from === selection.head,
  )
  if (adjacent === undefined) return false
  view.dispatch({ selection: EditorSelection.range(adjacent.from, adjacent.to) })
  return true
}

class InternalLinkWidget extends WidgetType {
  constructor(
    private readonly link: InternalLinkRange,
    private readonly resolution: Resolution,
    private readonly navigate: (targetId: NoteId) => void,
  ) {
    super()
  }

  eq(other: InternalLinkWidget) {
    return (
      this.link.label === other.link.label &&
      this.link.targetId === other.link.targetId &&
      this.resolution?.id === other.resolution?.id &&
      this.resolution?.title === other.resolution?.title &&
      (this.resolution === null) === (other.resolution === null)
    )
  }

  toDOM() {
    const element = document.createElement('button')
    element.type = 'button'
    element.setAttribute('role', 'link')
    element.className = `internal-link internal-link--${resolutionClass(this.resolution)}`
    element.textContent = `[[${this.link.label}]]`
    element.title = resolutionTitle(this.resolution)
    if (this.resolution === null) element.setAttribute('aria-disabled', 'true')
    const activate = () => {
      if (this.resolution !== undefined && this.resolution !== null) this.navigate(this.link.targetId)
    }
    element.addEventListener('click', activate)
    element.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      activate()
    })
    return element
  }

  ignoreEvent() {
    return false
  }
}

export function resolutionClass(resolution: Resolution): 'pending' | 'resolved' | 'unresolved' {
  if (resolution === undefined) return 'pending'
  return resolution === null ? 'unresolved' : 'resolved'
}

export function resolutionTitle(resolution: Resolution): string {
  if (resolution === undefined) return 'Resolving note link'
  return resolution === null ? 'Note is missing or deleted' : `Open ${resolution.title}`
}

export function markdownWithPreviewLinks(markdown: string, identity: string): {
  markdown: string
  links: InternalLinkRange[]
} {
  const links = parseInternalLinks(markdown)
  let rendered = markdown
  for (let index = links.length - 1; index >= 0; index -= 1) {
    const link = links[index]
    const label = link.label.replace(/([\\[\]])/g, '\\$1')
    const replacement = `[\\[\\[${label}\\]\\]](#simple-notes-internal-${identity}-${index})`
    rendered = `${rendered.slice(0, link.from)}${replacement}${rendered.slice(link.to)}`
  }
  return { markdown: rendered, links }
}

function scanInternalLinkCandidate(markdown: string, from: number):
  | { kind: 'complete'; close: number; separators: number[] }
  | { kind: 'nested'; from: number }
  | { kind: 'unterminated' } {
  const separators: number[] = []
  let index = from + 2
  while (index < markdown.length) {
    const character = markdown[index]
    if (character === '\\') {
      index += 2
      continue
    }
    if (markdown.startsWith('[[', index)) return { kind: 'nested', from: index }
    if (markdown.startsWith(']]', index)) return { kind: 'complete', close: index, separators }
    if (character === '|') separators.push(index)
    index += 1
  }
  return { kind: 'unterminated' }
}
