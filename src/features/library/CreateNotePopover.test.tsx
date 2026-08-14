import '@testing-library/jest-dom/vitest'
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Folder, FolderId } from '../../domain/model'
import { CreateNotePopover } from './CreateNotePopover'

const folderId = '019c0000-0000-7000-8000-000000000111' as FolderId
const folders: Folder[] = [{ id: folderId, parentId: null, name: '设计', sortOrder: 0 }]

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(cleanup)

describe('CreateNotePopover', () => {
  it('retains title and folder after failure and restores trigger focus on Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onCreate = vi.fn().mockRejectedValue(new Error('disk full'))
    const triggerRef = createRef<HTMLButtonElement>()
    render(<>
      <button ref={triggerRef}>新建笔记</button>
      <CreateNotePopover
        folders={folders}
        initialFolderId={null}
        triggerRef={triggerRef}
        onCreate={onCreate}
        onClose={onClose}
      />
    </>)

    await user.type(screen.getByRole('textbox', { name: '笔记标题' }), '潮汐设计')
    await user.selectOptions(screen.getByRole('combobox', { name: '保存到目录' }), folderId)
    await user.click(screen.getByRole('button', { name: '创建笔记' }))

    expect(screen.getByRole('alert')).toHaveTextContent('无法新建笔记')
    expect(screen.getByRole('textbox', { name: '笔记标题' })).toHaveValue('潮汐设计')
    expect(screen.getByRole('combobox', { name: '保存到目录' })).toHaveValue(folderId)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '新建笔记' })).toHaveFocus()
  })

  it('moves focus into the title and keeps Tab focus inside the popover', async () => {
    const user = userEvent.setup()
    const triggerRef = createRef<HTMLButtonElement>()
    render(<>
      <button ref={triggerRef}>新建笔记</button>
      <CreateNotePopover
        folders={folders}
        initialFolderId={folderId}
        triggerRef={triggerRef}
        onCreate={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />
    </>)

    const title = screen.getByRole('textbox', { name: '笔记标题' })
    expect(title).toHaveFocus()
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus()
    await user.tab()
    expect(title).toHaveFocus()
  })

  it('closes on an outside pointer action and restores the trigger focus', () => {
    const onClose = vi.fn()
    const triggerRef = createRef<HTMLButtonElement>()
    render(<>
      <button ref={triggerRef}>新建笔记</button>
      <CreateNotePopover
        folders={folders}
        initialFolderId={null}
        triggerRef={triggerRef}
        onCreate={vi.fn().mockResolvedValue(undefined)}
        onClose={onClose}
      />
    </>)

    const outsidePointer = createEvent.pointerDown(document.body)
    fireEvent(document.body, outsidePointer)
    expect(onClose).toHaveBeenCalledOnce()
    expect(triggerRef.current).toHaveFocus()
  })

  it('prevents duplicate submission while busy and closes after success', async () => {
    const pending = deferred()
    const onCreate = vi.fn(() => pending.promise)
    const onClose = vi.fn()
    const triggerRef = createRef<HTMLButtonElement>()
    const user = userEvent.setup()
    render(<>
      <button ref={triggerRef}>新建笔记</button>
      <CreateNotePopover
        folders={folders}
        initialFolderId={folderId}
        triggerRef={triggerRef}
        onCreate={onCreate}
        onClose={onClose}
      />
    </>)

    await user.type(screen.getByRole('textbox', { name: '笔记标题' }), '  潮汐设计  ')
    await user.click(screen.getByRole('button', { name: '创建笔记' }))
    expect(onCreate).toHaveBeenCalledWith('潮汐设计', folderId)
    expect(screen.getByRole('button', { name: '正在创建笔记' })).toBeDisabled()
    fireEvent.submit(screen.getByRole('form', { name: '新建笔记' }))
    expect(onCreate).toHaveBeenCalledOnce()

    pending.resolve()
    expect(await screen.findByRole('button', { name: '创建笔记' })).toBeEnabled()
    expect(onClose).toHaveBeenCalledOnce()
  })
})
