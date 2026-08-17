import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeSearchPort } from '../../test/fakes'
import { GlobalToolbar } from './GlobalToolbar'

describe('GlobalToolbar', () => {
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('renders branding once and keeps search between balanced semantic side tracks', () => {
    render(
      <GlobalToolbar
        search={fakeSearchPort()}
        saveState="saved"
        updateAttention="none"
        onSelectResult={vi.fn()}
        onCreateNote={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )

    const toolbar = screen.getByRole('toolbar', { name: '全局应用栏' })
    expect(screen.getAllByText('微屿')).toHaveLength(1)
    expect(within(toolbar).getByTestId('global-toolbar-brand')).toBeVisible()
    expect(within(toolbar).getByTestId('global-toolbar-search')).toBeVisible()
    expect(within(toolbar).getByTestId('global-toolbar-actions')).toBeVisible()
    expect(screen.getByRole('searchbox', { name: '搜索笔记' })).toHaveAttribute('placeholder', '搜索标题、正文或 #标签')
    expect(screen.getByRole('button', { name: '新建笔记' })).toBeVisible()
    expect(screen.getByRole('status', { name: '保存状态' })).toHaveTextContent('已保存')
  })

  it('routes explicit toolbar actions and only surfaces actionable update attention', async () => {
    const onCreateNote = vi.fn()
    const onOpenSettings = vi.fn()
    const user = userEvent.setup()
    const rendered = render(
      <GlobalToolbar
        search={fakeSearchPort()}
        saveState="hidden"
        updateAttention="none"
        onSelectResult={vi.fn()}
        onCreateNote={onCreateNote}
        onOpenSettings={onOpenSettings}
      />,
    )

    expect(screen.queryByRole('button', { name: /可用更新|需要重启/ })).not.toBeInTheDocument()
    const createTrigger = screen.getByRole('button', { name: '新建笔记' })
    await user.click(createTrigger)
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    expect(onCreateNote).toHaveBeenCalledWith(createTrigger)
    expect(onOpenSettings).toHaveBeenCalledOnce()

    rendered.rerender(
      <GlobalToolbar
        search={fakeSearchPort()}
        saveState="hidden"
        updateAttention="restart-required"
        onSelectResult={vi.fn()}
        onCreateNote={onCreateNote}
        onOpenSettings={onOpenSettings}
      />,
    )
    await user.click(screen.getByRole('button', { name: '更新已安装，需要重启，打开设置' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(2)
  })

  it('dismisses search results before opening create or settings surfaces', async () => {
    vi.useFakeTimers()
    const search = fakeSearchPort({
      search: vi.fn().mockResolvedValue([{
        noteId: '019c0000-0000-7000-8000-000000000061',
        title: '搜索结果',
        folderBreadcrumb: [],
        tags: [],
        excerpt: '',
        score: 1,
      }]),
    })
    render(
      <GlobalToolbar
        search={search}
        saveState="hidden"
        updateAttention="none"
        onSelectResult={vi.fn()}
        onCreateNote={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )
    const field = screen.getByRole('searchbox', { name: '搜索笔记' })

    fireEvent.change(field, { target: { value: '搜索' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(180) })
    expect(screen.getByRole('list', { name: '搜索结果' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '新建笔记' }))
    expect(screen.queryByRole('list', { name: '搜索结果' })).not.toBeInTheDocument()

    fireEvent.change(field, { target: { value: '搜索设置' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(180) })
    expect(screen.getByRole('list', { name: '搜索结果' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '打开设置' }))
    expect(screen.queryByRole('list', { name: '搜索结果' })).not.toBeInTheDocument()
  })
})
