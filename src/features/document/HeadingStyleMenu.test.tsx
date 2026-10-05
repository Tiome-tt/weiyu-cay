import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HeadingStyleMenu } from './HeadingStyleMenu'

afterEach(cleanup)

describe('HeadingStyleMenu', () => {
  it('keeps the H trigger and supports keyboard navigation with return focus', () => {
    render(<HeadingStyleMenu level={3} onChange={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: '段落样式' })
    expect(trigger).toHaveTextContent('H')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const current = screen.getByRole('menuitemradio', { name: '标题 3' })
    expect(current).toHaveFocus()
    fireEvent.keyDown(current, { key: 'End' })
    const last = screen.getByRole('menuitemradio', { name: '标题 6' })
    expect(last).toHaveFocus()
    fireEvent.keyDown(last, { key: 'ArrowDown' })
    const first = screen.getByRole('menuitemradio', { name: '正文' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('dismisses outside the menu without applying a heading', () => {
    const change = vi.fn()
    render(<HeadingStyleMenu level={0} onChange={change} />)
    fireEvent.click(screen.getByRole('button', { name: '段落样式' }))
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(change).not.toHaveBeenCalled()
  })
})

it('does not focus the checked item when opened with a pointer', () => {
 render(<HeadingStyleMenu level={0} onChange={vi.fn()} />)
 fireEvent.click(screen.getByRole('button', {name:'段落样式'}))
 expect(screen.getByRole('menuitemradio', {name:'正文'})).not.toHaveFocus()
})

it('closes a pointer-opened menu with Escape while editor focus is retained', () => {
 render(<HeadingStyleMenu level={0} onChange={vi.fn()} />)
 fireEvent.click(screen.getByRole('button',{name:'段落样式'}))
 fireEvent.keyDown(document.body,{key:'Escape'})
 expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})
