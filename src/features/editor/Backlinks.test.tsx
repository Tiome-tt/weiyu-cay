import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteId, NoteSummary } from '../../domain/model'
import type { LinkPort } from '../../domain/ports'
import { Backlinks } from './Backlinks'

const noteA = '019c0000-0000-7000-8000-000000000011' as NoteId
const noteB = '019c0000-0000-7000-8000-000000000012' as NoteId

function summary(id: NoteId, title: string): NoteSummary {
  return {
    id,
    kind: 'formal',
    title,
    folderId: null,
    tags: ['backend'],
    revision: 1,
    createdAt: '2026-07-30T08:00:00Z',
    updatedAt: '2026-07-30T08:00:00Z',
    excerpt: `${title} excerpt`,
  }
}

function port(backlinks: LinkPort['backlinks']): LinkPort {
  return {
    listTargets: vi.fn().mockResolvedValue([]),
    resolve: vi.fn().mockResolvedValue(null),
    backlinks,
    renameTargetLabels: vi.fn().mockResolvedValue({ updated: 0, failedSourceIds: [], failure: null }),
  }
}

afterEach(() => cleanup())

describe('Backlinks', () => {
  it('renders loading, results, source context, and a collapsible section', async () => {
    let finish!: (items: NoteSummary[]) => void
    const links = port(vi.fn(() => new Promise<NoteSummary[]>((done) => { finish = done })))
    render(<Backlinks noteId={noteA} links={links} onNavigate={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading backlinks')

    finish([{
      ...summary(noteB, 'Calling note'),
      excerpt: `Calling [[Target|${noteA}]] excerpt`,
    }])
    expect(await screen.findByRole('button', { name: /Calling note/ })).toBeVisible()
    expect(screen.getByText('Calling [[Target]] excerpt')).toBeVisible()
    expect(screen.queryByText(new RegExp(noteA))).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Backlinks/ }))
    expect(screen.queryByRole('button', { name: /Calling note/ })).not.toBeInTheDocument()
  })

  it('shows distinct empty and safe error states', async () => {
    const { rerender } = render(
      <Backlinks noteId={noteA} links={port(vi.fn().mockResolvedValue([]))} onNavigate={vi.fn()} />,
    )
    expect(await screen.findByText('No backlinks')).toBeVisible()

    rerender(
      <Backlinks
        noteId={noteB}
        links={port(vi.fn().mockRejectedValue(new Error('C:\\private\\note.md')))}
        onNavigate={vi.fn()}
      />,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load backlinks')
    expect(screen.queryByText(/private/)).not.toBeInTheDocument()
  })

  it('ignores stale loads and navigates only through the provided shared barrier', async () => {
    let finishOld!: (items: NoteSummary[]) => void
    const backlinks = vi.fn((id: NoteId) =>
      id === noteA
        ? new Promise<NoteSummary[]>((done) => { finishOld = done })
        : Promise.resolve([summary(noteA, 'Current source')]),
    )
    const navigate = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(
      <Backlinks noteId={noteA} links={port(backlinks)} onNavigate={navigate} />,
    )
    rerender(<Backlinks noteId={noteB} links={port(backlinks)} onNavigate={navigate} />)
    finishOld([summary(noteB, 'Stale source')])

    const current = await screen.findByRole('button', { name: /Current source/ })
    expect(screen.queryByRole('button', { name: /Stale source/ })).not.toBeInTheDocument()
    await userEvent.click(current)
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(noteA))
  })
})
