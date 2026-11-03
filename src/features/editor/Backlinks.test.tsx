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
  it('defaults indirect references on and filters them locally with a switch',async()=>{
    const neighborhood=vi.fn().mockResolvedValue({nodes:[{id:noteA,title:'当前',distance:0},{id:noteB,title:'间接',distance:2}],edges:[{source:noteA,target:noteB}],truncated:false})
    render(<Backlinks noteId={noteA} links={{...port(vi.fn().mockResolvedValue([])),neighborhood}} onNavigate={vi.fn()}/>)
    expect(await screen.findByRole('button',{name:'打开笔记：间接'})).toBeVisible()
    const toggle=screen.getByRole('switch',{name:'间接引用'})
    expect(toggle).toBeChecked()
    await userEvent.click(toggle)
    expect(screen.queryByRole('button',{name:'打开笔记：间接'})).not.toBeInTheDocument()
    expect(screen.getByLabelText('当前笔记：当前')).toBeVisible()
    expect(document.querySelectorAll('.related-graph__edges line')).toHaveLength(0)
    await userEvent.click(toggle)
    expect(screen.getByRole('button',{name:'打开笔记：间接'})).toBeVisible()
    expect(neighborhood).toHaveBeenCalledOnce()
    expect(screen.queryByText('直接与间接引用')).not.toBeInTheDocument()
  })
  it('shows incoming and indirect relations, highlights the current note, and resizes the two sides',async()=>{
    const links={...port(vi.fn().mockResolvedValue([])),neighborhood:vi.fn().mockResolvedValue({nodes:[{id:noteA,title:'当前',distance:0},{id:noteB,title:'间接',distance:2}],edges:[{source:noteA,target:noteB}],truncated:false})}
    const navigate=vi.fn()
    render(<Backlinks noteId={noteA} links={links} onNavigate={navigate}/>)
    const node=await screen.findByRole('button',{name:'打开笔记：间接'})
    expect(screen.getByLabelText('当前笔记：当前')).toHaveAttribute('aria-current','true')
    await userEvent.click(node);expect(navigate).toHaveBeenCalledWith(noteB)
    const divider=screen.getByRole('separator',{name:'调整引用列表与图谱宽度'})
    divider.focus();await userEvent.keyboard('{ArrowRight}')
    expect(divider).toHaveAttribute('aria-valuenow','55')
  })
  it('allows retrying a graph failure without reloading the incoming list',async()=>{
    const neighborhood=vi.fn().mockRejectedValueOnce(new Error('private')).mockResolvedValue({nodes:[],edges:[],truncated:false})
    const backlinks=vi.fn().mockResolvedValue([])
    render(<Backlinks noteId={noteA} links={{...port(backlinks),neighborhood}} onNavigate={vi.fn()}/>)
    await userEvent.click(await screen.findByRole('button',{name:'重试加载图谱'}))
    expect(await screen.findByLabelText('笔记关联图谱')).toBeVisible()
    expect(neighborhood).toHaveBeenCalledTimes(2)
    expect(backlinks).toHaveBeenCalledOnce()
    expect(screen.queryByText('private')).not.toBeInTheDocument()
  })
  it('renders loading, results, source context, and a collapsible section', async () => {
    let finish!: (items: NoteSummary[]) => void
    const links = port(vi.fn(() => new Promise<NoteSummary[]>((done) => { finish = done })))
    render(<Backlinks noteId={noteA} links={links} onNavigate={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('正在加载引用')

    finish([{
      ...summary(noteB, 'Calling note'),
      excerpt: `Calling [[Target|${noteA}]] excerpt`,
    }])
    expect(await screen.findByRole('button', { name: /Calling note/ })).toBeVisible()
    expect(screen.getByText('Calling [[Target]] excerpt')).toBeVisible()
    expect(screen.queryByText(new RegExp(noteA))).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /引用此笔记/ }))
    expect(screen.queryByRole('button', { name: /Calling note/ })).not.toBeInTheDocument()
  })

  it('shows distinct empty and safe error states', async () => {
    const { rerender } = render(
      <Backlinks noteId={noteA} links={port(vi.fn().mockResolvedValue([]))} onNavigate={vi.fn()} />,
    )
    expect(await screen.findByText('暂无引用')).toBeVisible()

    rerender(
      <Backlinks
        noteId={noteB}
        links={port(vi.fn().mockRejectedValue(new Error('C:\\private\\note.md')))}
        onNavigate={vi.fn()}
      />,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('无法加载引用')
    expect(screen.queryByText(/private/)).not.toBeInTheDocument()
  })

  it('reloads backlinks when the refresh token changes for the same note', async () => {
    const backlinks = vi.fn().mockResolvedValue([summary(noteB, '引用笔记')])
    const links = port(backlinks)
    const { rerender } = render(
      <Backlinks noteId={noteA} links={links} onNavigate={vi.fn()} refreshToken={0} />,
    )

    expect(await screen.findByRole('button', { name: /引用笔记/ })).toBeVisible()
    rerender(<Backlinks noteId={noteA} links={links} onNavigate={vi.fn()} refreshToken={1} />)
    await waitFor(() => expect(backlinks).toHaveBeenCalledTimes(2))
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
