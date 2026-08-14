import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteId } from '../../domain/model'
import type { SearchResult } from '../../domain/ports'
import { fakeSearchPort } from '../../test/fakes'
import { SearchBox } from './SearchBox'

afterEach(cleanup)

const firstId = '019c0000-0000-7000-8000-000000000061' as NoteId
const secondId = '019c0000-0000-7000-8000-000000000062' as NoteId

function result(noteId: NoteId, title: string, excerpt = '令牌失败后的恢复步骤'): SearchResult {
  return { noteId, title, folderBreadcrumb: ['工作', '项目 B'], tags: ['后端'], excerpt, score: 2 }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('SearchBox', () => {
  afterEach(() => vi.useRealTimers())

  it('searches after input settles without a submit button and closes on Escape', async () => {
    vi.useFakeTimers()
    const search = fakeSearchPort()
    render(<SearchBox search={search} onSelect={vi.fn()} />)
    const field = screen.getByRole('searchbox', { name: '搜索笔记' })

    fireEvent.change(field, { target: { value: '#设计' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(179) })
    expect(search.search).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(search.search).toHaveBeenCalledWith({ kind: 'tag', value: '设计' }, 100)
    expect(screen.queryByRole('button', { name: '搜索' })).not.toBeInTheDocument()
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByRole('list', { name: '搜索结果' })).not.toBeInTheDocument()
  })

  it('clears stale results while loading or errored and ignores late generations', async () => {
    const oldRequest = deferred<SearchResult[]>()
    const newRequest = deferred<SearchResult[]>()
    const search = fakeSearchPort({
      search: vi.fn(({ value }) => value === 'old' ? oldRequest.promise : newRequest.promise),
    })
    vi.useFakeTimers()
    render(<SearchBox search={search} onSelect={vi.fn()} />)
    const field = screen.getByRole('searchbox', { name: '搜索笔记' })

    fireEvent.change(field, { target: { value: 'old' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(180) })
    expect(screen.getByRole('status')).toHaveTextContent('正在搜索')
    fireEvent.change(field, { target: { value: 'new' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(180) })
    await act(async () => oldRequest.resolve([result(firstId, '旧结果')]))
    expect(screen.queryByText('旧结果')).not.toBeInTheDocument()
    await act(async () => newRequest.reject(new Error('offline')))
    expect(screen.getByRole('alert')).toHaveTextContent('搜索失败')
    expect(screen.queryByRole('list', { name: '搜索结果' })).not.toBeInTheDocument()
  })

  it('renders bounded result context and selects by immutable note ID', async () => {
    const search = fakeSearchPort({ search: vi.fn().mockResolvedValue([result(secondId, '令牌恢复')]) })
    const onSelect = vi.fn()
    vi.useFakeTimers()
    render(<SearchBox search={search} onSelect={onSelect} />)

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索笔记' }), { target: { value: '令牌' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(180) })
    const item = screen.getByRole('button', { name: /令牌恢复/ })
    expect(item).toHaveTextContent('工作 / 项目 B')
    expect(item).toHaveTextContent('#后端')
    expect(item).toHaveTextContent('令牌失败后的恢复步骤')
    fireEvent.click(item)
    expect(onSelect).toHaveBeenCalledWith(secondId)
    expect(screen.queryByRole('list', { name: '搜索结果' })).not.toBeInTheDocument()
  })

  it('keeps guidance inside the dropdown for invalid, empty-result, and error states', async () => {
    vi.useFakeTimers()
    const search = fakeSearchPort()
    render(<SearchBox search={search} onSelect={vi.fn()} />)
    const field = screen.getByRole('searchbox', { name: '搜索笔记' })

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    fireEvent.change(field, { target: { value: '#' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(180) })
    expect(screen.getByRole('status')).toHaveTextContent('# 后输入标签')
    fireEvent.change(field, { target: { value: 'missing' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(180) })
    expect(screen.getByRole('status')).toHaveTextContent('没有匹配的笔记')
  })

  it('moves through results with the keyboard and selects the active immutable ID', async () => {
    vi.useFakeTimers()
    const onSelect = vi.fn()
    const search = fakeSearchPort({ search: vi.fn().mockResolvedValue([result(firstId, '第一篇'), result(secondId, '第二篇')]) })
    render(<SearchBox search={search} onSelect={onSelect} />)
    const field = screen.getByRole('searchbox', { name: '搜索笔记' })

    fireEvent.change(field, { target: { value: '篇' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(180) })
    screen.getByRole('list', { name: '搜索结果' })
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    fireEvent.keyDown(field, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith(secondId)
    expect(screen.queryByRole('list', { name: '搜索结果' })).not.toBeInTheDocument()
  })
})
