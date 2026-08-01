import { EditorSelection, EditorState, StateEffect, type Extension } from '@codemirror/state'
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
import { isCanonicalUuidV7 } from '../../domain/ids'

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
const escapableLabelCharacters = new Set(['\\', '|', '[', ']'])

export const refreshInternalLinkContext = StateEffect.define<void>()

export function parseInternalLinks(markdown: string): InternalLinkRange[] {
  const links: InternalLinkRange[] = []
  let cursor = 0
  while (cursor < markdown.length) {
    const from = markdown.indexOf('[[', cursor)
    if (from < 0) break
    const candidate = scanInternalLinkCandidate(markdown, from)
    if (candidate.kind === 'unterminated') break
    if (candidate.kind === 'nested') {
      cursor = candidate.from
      continue
    }
    const to = candidate.close + 2
    if (candidate.separators.length === 1) {
      const separator = candidate.separators[0]
      const label = unescapeInternalLinkLabel(markdown.slice(from + 2, separator))
      const target = markdown.slice(separator + 1, candidate.close)
      if (
        label !== null &&
        isCanonicalUuidV7(target)
      ) {
        links.push({ from, to, label, targetId: target as NoteId })
      }
    }
    cursor = to
  }
  return links
}

export function serializeInternalLink(target: NoteSummary): string {
  return `[[${escapeInternalLinkLabel(target.title)}|${target.id}]]`
}

export function escapeInternalLinkLabel(label: string): string {
  let escaped = ''
  for (const character of label) {
    escaped += escapableLabelCharacters.has(character) ? `\\${character}` : character
  }
  return escaped
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
        this.generation += 1
        const retained = contextChanged ? undefined : new Map(this.resolutions)
        this.resolutions.clear()
        this.decorations = this.buildDecorations(retained)
      }

      private buildDecorations(retained?: ReadonlyMap<NoteId, Resolution>) {
        const ranges = parseInternalLinks(this.view.state.doc.toString())
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
    history(),
    EditorState.transactionFilter.of((transaction) => {
      if (!transaction.docChanged) return transaction
      const links = parseInternalLinks(transaction.startState.doc.toString())
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

export function insertInternalLink(view: EditorView, target: NoteSummary): boolean {
  const selection = view.state.selection.main
  const insert = serializeInternalLink(target)
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: EditorSelection.cursor(selection.from + insert.length),
    scrollIntoView: true,
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

function unescapeInternalLinkLabel(raw: string): string | null {
  if (raw.length === 0) return null
  let label = ''
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]
    if (character === '\\') {
      const escaped = raw[index + 1]
      if (escaped === undefined || !escapableLabelCharacters.has(escaped)) return null
      label += escaped
      index += 1
      continue
    }
    if (escapableLabelCharacters.has(character)) return null
    label += character
  }
  return label.length > 0 ? label : null
}
