import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
  it('dispatches text and #tag queries through the same field with a 100 result cap', async () => {
    const search = fakeSearchPort()
    const user = userEvent.setup()
    render(<SearchBox search={search} onSelect={vi.fn()} />)
    const field = screen.getByRole('searchbox', { name: '搜索笔记' })

    await user.type(field, '登录流程')
    await user.click(screen.getByRole('button', { name: '搜索' }))
    expect(search.search).toHaveBeenLastCalledWith({ kind: 'text', value: '登录流程' }, 100)

    await user.clear(field)
    await user.type(field, '#后端')
    await user.click(screen.getByRole('button', { name: '搜索' }))
    expect(search.search).toHaveBeenLastCalledWith({ kind: 'tag', value: '后端' }, 100)
  })

  it('clears stale results while loading or errored and ignores late generations', async () => {
    const oldRequest = deferred<SearchResult[]>()
    const newRequest = deferred<SearchResult[]>()
    const search = fakeSearchPort({
      search: vi.fn(({ value }) => value === 'old' ? oldRequest.promise : newRequest.promise),
    })
    const user = userEvent.setup()
    render(<SearchBox search={search} onSelect={vi.fn()} />)
    const field = screen.getByRole('searchbox', { name: '搜索笔记' })

    await user.type(field, 'old')
    await user.click(screen.getByRole('button', { name: '搜索' }))
    expect(screen.getByRole('status')).toHaveTextContent('正在搜索')
    await user.clear(field)
    await user.type(field, 'new')
    await user.click(screen.getByRole('button', { name: '搜索' }))
    await act(async () => oldRequest.resolve([result(firstId, '旧结果')]))
    expect(screen.queryByText('旧结果')).not.toBeInTheDocument()
    await act(async () => newRequest.reject(new Error('offline')))
    expect(screen.getByRole('alert')).toHaveTextContent('搜索失败')
    expect(screen.queryByRole('list', { name: '搜索结果' })).not.toBeInTheDocument()
  })

  it('renders bounded result context and selects by immutable note ID', async () => {
    const search = fakeSearchPort({ search: vi.fn().mockResolvedValue([result(secondId, '令牌恢复')]) })
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<SearchBox search={search} onSelect={onSelect} />)

    await user.type(screen.getByRole('searchbox', { name: '搜索笔记' }), '令牌')
    await user.click(screen.getByRole('button', { name: '搜索' }))
    const item = await screen.findByRole('button', { name: /令牌恢复/ })
    expect(item).toHaveTextContent('工作 / 项目 B')
    expect(item).toHaveTextContent('#后端')
    expect(item).toHaveTextContent('令牌失败后的恢复步骤')
    await user.click(item)
    expect(onSelect).toHaveBeenCalledWith(secondId)
  })

  it('shows clear guidance for empty, bare-tag, empty-result, and invalid queries', async () => {
    const search = fakeSearchPort()
    const user = userEvent.setup()
    render(<SearchBox search={search} onSelect={vi.fn()} />)
    const field = screen.getByRole('searchbox', { name: '搜索笔记' })

    await user.click(screen.getByRole('button', { name: '搜索' }))
    expect(screen.getByRole('status')).toHaveTextContent('输入文字搜索标题和正文')
    await user.type(field, '#')
    await user.click(screen.getByRole('button', { name: '搜索' }))
    expect(screen.getByRole('status')).toHaveTextContent('# 后输入标签')
    await user.clear(field)
    await user.type(field, 'missing')
    await user.click(screen.getByRole('button', { name: '搜索' }))
    expect(await screen.findByRole('status')).toHaveTextContent('没有匹配的笔记')
  })
})
