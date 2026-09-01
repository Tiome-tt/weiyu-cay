import '@testing-library/jest-dom/vitest'
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Folder, FolderId } from '../../domain/model'
import { CreateNotePopover, type CreateNoteDraft, type CreateNoteStatus } from './CreateNotePopover'

const folderId = '019c0000-0000-7000-8000-000000000111' as FolderId
const folders: Folder[] = [{ id: folderId, parentId: null, name: '设计', sortOrder: 0 }]

afterEach(cleanup)

function ControlledPopover({
  initialDraft = { title: '', folderId: null, tags: '' },
  status = 'idle',
  onCreate = vi.fn(),
  onClose = vi.fn(),
}: {
  initialDraft?: CreateNoteDraft
  status?: CreateNoteStatus
  onCreate?: (title: string, folderId: FolderId | null, tags: string[]) => void
  onClose?: () => void
}) {
  const [draft, setDraft] = useState(initialDraft)
  const triggerRef = createRef<HTMLButtonElement>()
  return <>
    <button ref={triggerRef}>新建笔记</button>
    <CreateNotePopover
      folders={folders}
      draft={draft}
      status={status}
      triggerRef={triggerRef}
      onDraftChange={setDraft}
      onCreate={onCreate}
      onClose={onClose}
    />
  </>
}

describe('CreateNotePopover', () => {
  it('requires a real folder instead of offering an unfiled destination', async () => {
    const onCreate = vi.fn()
    render(<ControlledPopover initialDraft={{ title: '新笔记', folderId: null, tags: '' }} onCreate={onCreate} />)
    const select = screen.getByRole('combobox', { name: '保存到目录' })
    expect(screen.queryByRole('option', { name: '未归档笔记' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '创建笔记' })).toBeDisabled()
    fireEvent.submit(screen.getByRole('form', { name: '新建笔记' }))
    expect(onCreate).not.toHaveBeenCalled()
    await userEvent.setup().selectOptions(select, folderId)
    fireEvent.submit(screen.getByRole('form', { name: '新建笔记' }))
    expect(onCreate).toHaveBeenCalledWith('新笔记', folderId, [])
  })

  it('retains the owner draft after failure and restores trigger focus on Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<ControlledPopover
      initialDraft={{ title: '潮汐设计', folderId, tags: '' }}
      status="error"
      onClose={onClose}
    />)

    expect(screen.getByRole('alert')).toHaveTextContent('无法新建笔记')
    expect(screen.getByRole('textbox', { name: '笔记标题' })).toHaveValue('潮汐设计')
    expect(screen.getByRole('combobox', { name: '保存到目录' })).toHaveValue(folderId)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '新建笔记' })).toHaveFocus()
  })

  it('moves focus into the title and keeps Tab focus inside the popover', async () => {
    const user = userEvent.setup()
    render(<ControlledPopover initialDraft={{ title: '', folderId, tags: '' }} />)

    const title = screen.getByRole('textbox', { name: '笔记标题' })
    expect(title).toHaveFocus()
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus()
    await user.tab()
    expect(title).toHaveFocus()
  })

  it('closes on an outside pointer action and restores the trigger focus', () => {
    const onClose = vi.fn()
    render(<ControlledPopover onClose={onClose} />)

    const outsidePointer = createEvent.pointerDown(document.body)
    fireEvent(document.body, outsidePointer)
    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '新建笔记' })).toHaveFocus()
  })

  it('allows Escape while pending and keeps the submitted draft read-only', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn()
    const onClose = vi.fn()
    render(<ControlledPopover
      initialDraft={{ title: '  潮汐设计  ', folderId, tags: '' }}
      status="pending"
      onCreate={onCreate}
      onClose={onClose}
    />)

    const title = screen.getByRole('textbox', { name: '笔记标题' })
    expect(title).toHaveFocus()
    expect(title).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: '正在创建笔记' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '取消' })).toBeEnabled()
    expect(screen.getByRole('dialog', { name: '新建笔记' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('正在创建笔记')
    fireEvent.submit(screen.getByRole('form', { name: '新建笔记' }))
    expect(onCreate).not.toHaveBeenCalled()

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '新建笔记' })).toHaveFocus()
  })
})
