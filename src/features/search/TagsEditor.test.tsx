import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TagsEditor } from './TagsEditor'

afterEach(cleanup)

describe('TagsEditor', () => {
  it('adds with Enter, suppresses duplicates, and removes through accessible controls', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    const { rerender } = render(<TagsEditor tags={['TypeScript']} onChange={onChange} />)
    const input = screen.getByRole('textbox', { name: '添加标签' })

    await user.type(input, ' typescript {Enter}')
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('标签已存在')

    await user.clear(input)
    await user.type(input, '后端{Enter}')
    expect(onChange).toHaveBeenCalledWith(['TypeScript', '后端'])

    rerender(<TagsEditor tags={['TypeScript', '后端']} onChange={onChange} />)
    const remove = within(screen.getByText('TypeScript').closest('span')!).getByRole('button')
    expect(within(remove).getByTestId('icon-close')).toBeVisible()
    expect(within(screen.getByRole('button', { name: '添加标签' })).getByTestId('icon-plus')).toBeVisible()
    await user.click(remove)
    expect(onChange).toHaveBeenLastCalledWith(['后端'])
  })

  it('validates empty, control, and overlong tags without calling persistence', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<TagsEditor tags={[]} onChange={onChange} />)
    const input = screen.getByRole('textbox', { name: '添加标签' })

    await user.click(screen.getByRole('button', { name: '添加标签' }))
    expect(screen.getByRole('alert')).toHaveTextContent('请输入标签')
    await user.type(input, 'a'.repeat(81))
    await user.click(screen.getByRole('button', { name: '添加标签' }))
    expect(screen.getByRole('alert')).toHaveTextContent('标签过长')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('serializes changes, disables controls while busy, and recovers after failure', async () => {
    let reject!: (reason: Error) => void
    const pending = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise
    })
    const onChange = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(undefined)
    const user = userEvent.setup()
    render(<TagsEditor tags={[]} onChange={onChange} />)
    const input = screen.getByRole('textbox', { name: '添加标签' })

    await user.type(input, 'backend{Enter}')
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: '添加标签' })).toBeDisabled()
    reject(new Error('private failure'))
    expect(await screen.findByRole('alert')).toHaveTextContent('无法更新标签')
    expect(screen.getByRole('alert')).not.toHaveTextContent('private')

    await waitFor(() => expect(input).toBeEnabled())
    await user.clear(input)
    await user.type(input, 'backend{Enter}')
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2))
  })
})
