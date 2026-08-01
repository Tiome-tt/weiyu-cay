import '@testing-library/jest-dom/vitest'
import { redo, undo } from '@codemirror/commands'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement, createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteId, NoteSummary } from '../../domain/model'
import type { LinkPort } from '../../domain/ports'
import { MarkdownPreview } from './MarkdownPreview'
import { MarkdownSource, type MarkdownSourceHandle } from './MarkdownSource'
import {
  displayInternalLinks,
  insertInternalLink,
  parseInternalLinks,
  serializeInternalLink,
} from './internalLinks'
import { pngBytes } from '../../test/fakes'

const targetId = '019c0000-0000-7000-8000-000000000002' as NoteId
const otherId = '019c0000-0000-7000-8000-000000000003' as NoteId

function summary(id: NoteId, title: string): NoteSummary {
  return {
    id,
    kind: 'formal',
    title,
    folderId: null,
    tags: [],
    revision: 1,
    createdAt: '2026-07-30T08:00:00Z',
    updatedAt: '2026-07-30T08:00:00Z',
    excerpt: `${title} excerpt`,
  }
}

function linkPort(overrides: Partial<LinkPort> = {}): LinkPort {
  return {
    resolve: vi.fn().mockResolvedValue(null),
    backlinks: vi.fn().mockResolvedValue([]),
    renameTargetLabels: vi.fn().mockResolvedValue({ updated: 0, failedSourceIds: [] }),
    ...overrides,
  }
}

function editorView() {
  const textbox = screen.getByRole('textbox', { name: 'Markdown source' })
  const view = EditorView.findFromDOM(textbox)
  if (view === null) throw new Error('CodeMirror view not found')
  return view
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('persisted internal link helpers', () => {
  it('parses Unicode labels and returns UTF-16 ranges for adjacent valid links', () => {
    const markdown = `😀 [[用户认证|${targetId}]][[API|${otherId}]] end`

    expect(parseInternalLinks(markdown)).toEqual([
      {
        from: 3,
        to: 3 + `[[用户认证|${targetId}]]`.length,
        label: '用户认证',
        targetId,
      },
      {
        from: 3 + `[[用户认证|${targetId}]]`.length,
        to: 3 + `[[用户认证|${targetId}]][[API|${otherId}]]`.length,
        label: 'API',
        targetId: otherId,
      },
    ])
  })

  it('ignores ordinary wiki text, empty/nested labels, invalid UUIDs, and malformed links', () => {
    const markdown = [
      '[[ordinary]]',
      `[[|${targetId}]]`,
      `[[nested [label]|${targetId}]]`,
      '[[bad|019c0000-0000-6000-8000-000000000002]]',
      `[[missing close|${targetId}]`,
      `[[valid|${targetId}]]`,
    ].join(' ')

    expect(parseInternalLinks(markdown)).toEqual([
      expect.objectContaining({ label: 'valid', targetId }),
    ])
  })

  it('serializes a selected target while keeping its UUID out of the display helper', () => {
    expect(serializeInternalLink(summary(targetId, '用户认证'))).toBe(
      `[[用户认证|${targetId}]]`,
    )
  })

  it('round-trips reserved characters in labels through one shared escape grammar', () => {
    const title = String.raw`API \ path | [draft] 中文`
    const durable = String.raw`[[API \\ path \| \[draft\] 中文|019c0000-0000-7000-8000-000000000002]]`

    expect(serializeInternalLink(summary(targetId, title))).toBe(durable)
    expect(parseInternalLinks(durable)).toEqual([
      { from: 0, to: durable.length, label: title, targetId },
    ])
    expect(displayInternalLinks(durable)).toBe(`[[${title}]]`)
  })

  it('rejects malformed escapes and unescaped reserved label characters', () => {
    const markdown = [
      String.raw`[[bad\q|${targetId}]]`,
      String.raw`[[bad\|${targetId}]]`,
      `[[bad|pipe|${targetId}]]`,
      `[[bad[label|${targetId}]]`,
      `[[bad]label|${targetId}]]`,
      `[[plain label|${targetId}]]`,
    ].join(' ')

    expect(parseInternalLinks(markdown)).toEqual([
      expect.objectContaining({ label: 'plain label', targetId }),
    ])
  })

  it('inserts a chosen typed note summary as durable syntax and displays it atomically', () => {
    render(createElement(MarkdownSource, {
      markdown: 'before selected after',
      onChange: vi.fn(),
      links: linkPort(),
      linkCache: new Map([[targetId, summary(targetId, '用户认证')]]),
    }))
    const view = editorView()
    view.dispatch({ selection: EditorSelection.range(7, 15) })

    expect(insertInternalLink(view, summary(targetId, '用户认证'))).toBe(true)

    expect(view.state.doc.toString()).toBe(`before [[用户认证|${targetId}]] after`)
    expect(screen.getByRole('link', { name: '[[用户认证]]' })).toBeVisible()
  })
})

describe('CodeMirror internal link extension', () => {
  it('hides the UUID and resolves from cache without calling the fallback port', async () => {
    const links = linkPort()
    render(createElement(MarkdownSource, {
      markdown: `See [[用户认证|${targetId}]]`,
      onChange: vi.fn(),
      links,
      linkCache: new Map([[targetId, summary(targetId, '用户认证')]]),
      onNavigateLink: vi.fn(),
    }))

    const widget = await screen.findByRole('link', { name: '[[用户认证]]' })
    expect(widget).toHaveClass('internal-link--resolved')
    expect(screen.queryByText(new RegExp(targetId))).not.toBeInTheDocument()
    expect(links.resolve).not.toHaveBeenCalled()
  })

  it('uses fallback resolution, renders missing targets unresolved, and ignores stale responses', async () => {
    let resolveOld!: (value: NoteSummary | null) => void
    const links = linkPort({
      resolve: vi.fn((id: NoteId) =>
        id === targetId
          ? new Promise<NoteSummary | null>((done) => { resolveOld = done })
          : Promise.resolve(null),
      ),
    })
    const { rerender } = render(createElement(MarkdownSource, {
      markdown: `[[Old|${targetId}]]`,
      onChange: vi.fn(),
      links,
      linkCache: new Map(),
      onNavigateLink: vi.fn(),
    }))
    await waitFor(() => expect(links.resolve).toHaveBeenCalledWith(targetId))

    rerender(createElement(MarkdownSource, {
      markdown: `[[Missing|${otherId}]]`,
      onChange: vi.fn(),
      links,
      linkCache: new Map(),
      onNavigateLink: vi.fn(),
    }))
    await act(async () => resolveOld(summary(targetId, 'Old')))

    const widget = await screen.findByRole('link', { name: '[[Missing]]' })
    await waitFor(() => expect(widget).toHaveClass('internal-link--unresolved'))
    expect(screen.queryByRole('link', { name: '[[Old]]' })).not.toBeInTheDocument()
  })

  it('refreshes an unchanged document when cached targets disappear and reappear', async () => {
    const navigate = vi.fn()
    const links = linkPort({ resolve: vi.fn().mockResolvedValue(null) })
    const props = {
      markdown: `[[Target|${targetId}]]`,
      onChange: vi.fn(),
      links,
      onNavigateLink: navigate,
    }
    const { rerender } = render(createElement(MarkdownSource, {
      ...props,
      linkCache: new Map([[targetId, summary(targetId, 'Target')]]),
    }))
    expect(screen.getByRole('link', { name: '[[Target]]' })).toHaveClass('internal-link--resolved')

    rerender(createElement(MarkdownSource, { ...props, linkCache: new Map() }))
    await waitFor(() => expect(screen.getByRole('link', { name: '[[Target]]' })).toHaveClass('internal-link--unresolved'))
    fireEvent.click(screen.getByRole('link', { name: '[[Target]]' }))
    expect(navigate).not.toHaveBeenCalled()

    rerender(createElement(MarkdownSource, {
      ...props,
      linkCache: new Map([[targetId, summary(targetId, 'Target again')]]),
    }))
    await waitFor(() => expect(screen.getByRole('link', { name: '[[Target]]' })).toHaveClass('internal-link--resolved'))
    fireEvent.click(screen.getByRole('link', { name: '[[Target]]' }))
    expect(navigate).toHaveBeenCalledWith(targetId)
  })

  it('does not let an older fallback overwrite a newer cache generation', async () => {
    let finish!: (value: NoteSummary | null) => void
    const links = linkPort({
      resolve: vi.fn(() => new Promise<NoteSummary | null>((resolve) => { finish = resolve })),
    })
    const props = { markdown: `[[Target|${targetId}]]`, onChange: vi.fn(), links }
    const { rerender } = render(createElement(MarkdownSource, { ...props, linkCache: new Map() }))
    await waitFor(() => expect(links.resolve).toHaveBeenCalledWith(targetId))

    rerender(createElement(MarkdownSource, {
      ...props,
      linkCache: new Map([[targetId, summary(targetId, 'Fresh')]]),
    }))
    await act(async () => finish(null))

    expect(screen.getByRole('link', { name: '[[Target]]' })).toHaveClass('internal-link--resolved')
  })

  it('selects a whole link on the first adjacent deletion and removes it on the second', () => {
    const raw = `[[用户认证|${targetId}]]`
    render(createElement(MarkdownSource, { markdown: `See ${raw}`, onChange: vi.fn(), links: linkPort() }))
    const view = editorView()
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) })

    fireEvent.keyDown(view.contentDOM, { key: 'Backspace' })
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(raw)
    fireEvent.keyDown(view.contentDOM, { key: 'Backspace' })
    expect(view.state.doc.toString()).toBe('See ')

    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(`See ${raw}`)
    expect(redo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('See ')
  })

  it('selects a whole adjacent link on forward Delete and removes it on the second press', () => {
    const raw = `[[Target|${targetId}]]`
    render(createElement(MarkdownSource, { markdown: `${raw} tail`, onChange: vi.fn(), links: linkPort() }))
    const view = editorView()
    view.dispatch({ selection: EditorSelection.cursor(0) })

    fireEvent.keyDown(view.contentDOM, { key: 'Delete' })
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(raw)
    fireEvent.keyDown(view.contentDOM, { key: 'Delete' })
    expect(view.state.doc.toString()).toBe(' tail')
  })

  it('expands a partial overlapping deletion to the complete raw link before deleting', () => {
    const raw = `[[Target|${targetId}]]`
    render(createElement(MarkdownSource, { markdown: `A ${raw} Z`, onChange: vi.fn(), links: linkPort() }))
    const view = editorView()
    const start = 2
    view.dispatch({ selection: EditorSelection.range(start + 2, start + 8) })

    fireEvent.keyDown(view.contentDOM, { key: 'Delete' })
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(raw)
    fireEvent.keyDown(view.contentDOM, { key: 'Delete' })
    expect(view.state.doc.toString()).toBe('A  Z')
  })

  it('rejects typing, paste-like, composition, and drag transactions inside hidden raw syntax', () => {
    const raw = `[[Target|${targetId}]]`
    render(createElement(MarkdownSource, { markdown: `A ${raw} Z`, onChange: vi.fn(), links: linkPort() }))
    const view = editorView()
    const before = view.state.doc.toString()
    const insideLabel = 5
    const insideUuid = before.indexOf(targetId) + 4

    view.dispatch({ changes: { from: insideLabel, insert: 'typed' }, userEvent: 'input.type' })
    view.dispatch({ changes: { from: insideUuid, to: insideUuid + 2, insert: 'paste' }, userEvent: 'input.paste' })
    view.dispatch({ changes: { from: insideLabel, insert: '合成' }, userEvent: 'input.type.compose' })
    view.dispatch({ changes: { from: insideUuid, insert: 'dragged' }, userEvent: 'input.drop' })

    expect(view.state.doc.toString()).toBe(before)
  })

  it('accepts controlled replacement without feedback and rebuilds atomic links', () => {
    const onChange = vi.fn()
    const { rerender } = render(createElement(MarkdownSource, {
      markdown: `[[Old|${targetId}]]`,
      onChange,
      links: linkPort(),
    }))

    rerender(createElement(MarkdownSource, {
      markdown: `prefix [[New|${otherId}]]`,
      onChange,
      links: linkPort(),
    }))

    expect(editorView().state.doc.toString()).toBe(`prefix [[New|${otherId}]]`)
    expect(screen.getByRole('link', { name: '[[New]]' })).toBeVisible()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('inserts a pre-barrier authorized image paste beside a link and publishes the result', async () => {
    let finish!: (value: { relativePath: string; width: number; height: number }) => void
    const assets = {
      saveImage: vi.fn(() => new Promise<{ relativePath: string; width: number; height: number }>((resolve) => {
        finish = resolve
      })),
    }
    const ref = createRef<MarkdownSourceHandle>()
    const raw = `[[Target|${targetId}]]`
    const onChange = vi.fn()
    render(createElement(MarkdownSource, {
      ref,
      markdown: `${raw} tail`,
      noteId: targetId,
      assets,
      onChange,
      links: linkPort(),
    }))
    const view = editorView()
    view.dispatch({ selection: EditorSelection.cursor(raw.length) })
    fireEvent.paste(view.contentDOM, {
      clipboardData: {
        files: [{ type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer }],
        getData: () => '',
      },
    })
    await waitFor(() => expect(assets.saveImage).toHaveBeenCalledOnce())

    const barrier = ref.current!.beginEditBarrier()
    await act(async () => finish({ relativePath: 'assets/authorized.png', width: 1, height: 1 }))
    await barrier

    const expected = `${raw}![截图](assets/authorized.png) tail`
    expect(view.state.doc.toString()).toBe(expected)
    expect(onChange).toHaveBeenLastCalledWith(expected)
    expect(parseInternalLinks(view.state.doc.toString())).toEqual([
      expect.objectContaining({ label: 'Target', targetId }),
    ])
    ref.current!.endEditBarrier()
  })

  it('composes link protection with a read-only tag transaction and resumes editing afterward', () => {
    const onChange = vi.fn()
    const raw = `[[Target|${targetId}]]`
    const props = { markdown: `${raw} tail`, onChange, links: linkPort() }
    const { rerender } = render(createElement(MarkdownSource, { ...props, readOnly: true }))
    const view = editorView()

    view.dispatch({ changes: { from: raw.length, insert: ' blocked' } })
    expect(view.state.doc.toString()).toBe(`${raw} tail`)
    expect(onChange).not.toHaveBeenCalled()

    rerender(createElement(MarkdownSource, { ...props, readOnly: false }))
    view.dispatch({ changes: { from: view.state.doc.length, insert: ' edited' } })
    expect(view.state.doc.toString()).toBe(`${raw} tail edited`)
    expect(parseInternalLinks(view.state.doc.toString())).toEqual([
      expect.objectContaining({ label: 'Target', targetId }),
    ])
  })

  it('activates a resolved widget by click and Enter but never activates unresolved widgets', async () => {
    const navigate = vi.fn().mockResolvedValue(undefined)
    const links = linkPort({
      resolve: vi.fn((id: NoteId) => Promise.resolve(id === targetId ? summary(targetId, 'Target') : null)),
    })
    render(createElement(MarkdownSource, {
      markdown: `[[Target|${targetId}]] [[Missing|${otherId}]]`,
      onChange: vi.fn(),
      links,
      linkCache: new Map(),
      onNavigateLink: navigate,
    }))
    await waitFor(() => expect(screen.getByRole('link', { name: '[[Target]]' })).toHaveClass('internal-link--resolved'))
    const resolved = screen.getByRole('link', { name: '[[Target]]' })
    fireEvent.click(resolved)
    fireEvent.keyDown(resolved, { key: 'Enter' })
    expect(navigate).toHaveBeenCalledTimes(2)
    expect(navigate).toHaveBeenLastCalledWith(targetId)

    const unresolved = screen.getByRole('link', { name: '[[Missing]]' })
    await waitFor(() => expect(unresolved).toHaveClass('internal-link--unresolved'))
    fireEvent.click(unresolved)
    expect(navigate).toHaveBeenCalledTimes(2)
  })
})

describe('internal links in preview', () => {
  it('shows only the visible label, sanitizes HTML, and activates resolved targets', async () => {
    const navigate = vi.fn()
    render(createElement(MarkdownPreview, {
      markdown: `<script>alert(1)</script>\n\n[[用户认证|${targetId}]]`,
      links: linkPort({ resolve: vi.fn().mockResolvedValue(summary(targetId, '用户认证')) }),
      linkCache: new Map(),
      onNavigateLink: navigate,
    }))

    await screen.findByRole('link', { name: '[[用户认证]]' })
    await waitFor(() => expect(screen.getByRole('link', { name: '[[用户认证]]' })).toHaveClass('internal-link--resolved'))
    const link = screen.getByRole('link', { name: '[[用户认证]]' })
    expect(screen.queryByText(new RegExp(targetId))).not.toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
    await userEvent.click(link)
    expect(navigate).toHaveBeenCalledWith(targetId)
  })

  it('never treats an ordinary Markdown fragment as an internal-link identity', async () => {
    const navigate = vi.fn()
    render(createElement(MarkdownPreview, {
      markdown: `[spoof](#simple-notes-internal-0)\n\n[[Target|${targetId}]]`,
      links: linkPort({ resolve: vi.fn().mockResolvedValue(summary(targetId, 'Target')) }),
      linkCache: new Map(),
      onNavigateLink: navigate,
    }))
    const spoof = screen.getByRole('link', { name: 'spoof' })
    await userEvent.click(spoof)
    expect(navigate).not.toHaveBeenCalled()

    const internal = await screen.findByRole('link', { name: '[[Target]]' })
    await waitFor(() => expect(internal).toHaveClass('internal-link--resolved'))
    await userEvent.click(internal)
    expect(navigate).toHaveBeenCalledWith(targetId)
  })
})
