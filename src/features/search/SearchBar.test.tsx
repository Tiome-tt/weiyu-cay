import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteId } from '../../domain/model'
import type { SearchResult } from '../../domain/ports'
import { fakeSearchPort } from '../../test/fakes'
import { SearchBar } from './SearchBar'

afterEach(cleanup)

const firstId = '019c0000-0000-7000-8000-000000000061' as NoteId
const secondId = '019c0000-0000-7000-8000-000000000062' as NoteId

function result(noteId: NoteId, title: string): SearchResult {
  return { noteId, title, folderBreadcrumb: ['Work', 'Project B'], tags: ['Backend'], excerpt: '', score: 3 }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('SearchBar', () => {
  it('guides bare tag and text queries without issuing incomplete backend searches', async () => {
    const search = fakeSearchPort()
    const user = userEvent.setup()
    render(<SearchBar search={search} onSelect={vi.fn()} />)
    const field = screen.getByRole('searchbox', { name: '搜索笔记' })

    await user.type(field, '#')
    await user.click(screen.getByRole('button', { name: '搜索' }))
    expect(screen.getByRole('status')).toHaveTextContent('请在 # 后输入')
    await user.clear(field)
    await user.type(field, '正文')
    await user.click(screen.getByRole('button', { name: '搜索' }))
    expect(screen.getByRole('status')).toHaveTextContent('当前支持 #标签')
    expect(search.search).not.toHaveBeenCalled()
  })

  it('keeps newer results when an older request resolves late and selects by note ID', async () => {
    const oldRequest = deferred<SearchResult[]>()
    const newRequest = deferred<SearchResult[]>()
    const search = fakeSearchPort({
      search: vi.fn(({ value }) => value === 'old' ? oldRequest.promise : newRequest.promise),
    })
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<SearchBar search={search} onSelect={onSelect} />)
    const field = screen.getByRole('searchbox', { name: '搜索笔记' })

    await user.type(field, '#old')
    await user.click(screen.getByRole('button', { name: '搜索' }))
    await user.clear(field)
    await user.type(field, '#new')
    await user.click(screen.getByRole('button', { name: '搜索' }))
    await act(async () => newRequest.resolve([result(secondId, 'New result')]))
    expect(screen.getByRole('button', { name: /New result/ })).toHaveTextContent('Work / Project B')
    await act(async () => oldRequest.resolve([result(firstId, 'Old result')]))
    expect(screen.queryByText('Old result')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /New result/ }))
    expect(onSelect).toHaveBeenCalledWith(secondId)
  })

  it('does not show prior-query results while a new query loads or after it fails', async () => {
    let rejectNext!: (error: Error) => void
    const next = new Promise<SearchResult[]>((_resolve, reject) => { rejectNext = reject })
    const search = fakeSearchPort({
      search: vi.fn()
        .mockResolvedValueOnce([result(firstId, 'Old result')])
        .mockReturnValueOnce(next),
    })
    const user = userEvent.setup()
    render(<SearchBar search={search} onSelect={vi.fn()} />)
    const field = screen.getByRole('searchbox', { name: '搜索笔记' })
    await user.type(field, '#old')
    await user.click(screen.getByRole('button', { name: '搜索' }))
    expect(await screen.findByText('Old result')).toBeVisible()

    await user.clear(field)
    await user.type(field, '#new')
    await user.click(screen.getByRole('button', { name: '搜索' }))
    expect(screen.queryByText('Old result')).not.toBeInTheDocument()
    await act(async () => rejectNext(new Error('offline')))
    expect(await screen.findByRole('alert')).toHaveTextContent('搜索失败')
    expect(screen.queryByText('Old result')).not.toBeInTheDocument()
  })
})
