import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SplitPane } from './SplitPane'

const labels = ['调整文件夹栏宽度', '调整笔记列表栏宽度'] as const

function renderPane(onCommit = vi.fn()) {
  render(
    <SplitPane
      defaultSizes={[240, 300]}
      minimumSizes={[180, 220, 420]}
      dividerLabels={labels}
      onCommit={onCommit}
    >
      <div data-testid="first-pane" />
      <div data-testid="second-pane" />
      <div data-testid="third-pane" />
    </SplitPane>,
  )
  return { onCommit, dividers: screen.getAllByRole('separator') }
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
    configurable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SplitPane', () => {
  it('captures a pointer, resizes from the boundary position, and commits only on release', () => {
    const setPointerCapture = vi
      .spyOn(HTMLElement.prototype, 'setPointerCapture')
      .mockImplementation(() => undefined)
    const releasePointerCapture = vi
      .spyOn(HTMLElement.prototype, 'releasePointerCapture')
      .mockImplementation(() => undefined)
    const { onCommit, dividers } = renderPane()

    fireEvent.pointerDown(dividers[0], { clientX: 220, pointerId: 7 })
    fireEvent.pointerMove(dividers[0], { clientX: 300, pointerId: 7 })

    expect(screen.getByTestId('first-pane')).toHaveStyle({ width: '300px' })
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.pointerUp(dividers[0], { pointerId: 7 })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(setPointerCapture).toHaveBeenCalledWith(7)
    expect(releasePointerCapture).toHaveBeenCalledWith(7)
  })

  it('keeps and commits the usable in-memory size when pointer dragging is cancelled', () => {
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => undefined)
    vi.spyOn(HTMLElement.prototype, 'releasePointerCapture').mockImplementation(() => undefined)
    const { onCommit, dividers } = renderPane()

    fireEvent.pointerDown(dividers[1], { clientX: 540, pointerId: 8 })
    fireEvent.pointerMove(dividers[1], { clientX: 620, pointerId: 8 })
    fireEvent.pointerCancel(dividers[1], { pointerId: 8 })

    expect(screen.getByTestId('second-pane')).toHaveStyle({ width: '372px' })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('resizes by keyboard in a stable step and commits when the key is released', () => {
    const { onCommit, dividers } = renderPane()

    fireEvent.keyDown(dividers[0], { key: 'ArrowRight' })
    expect(screen.getByTestId('first-pane')).toHaveStyle({ width: '256px' })
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.keyUp(dividers[0], { key: 'ArrowRight' })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('reports separator ranges that preserve the other pane and editor minimums', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 700,
      height: 700,
      left: 0,
      right: 1200,
      top: 0,
      width: 1200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const { dividers } = renderPane()

    expect(dividers[0]).toHaveAttribute('aria-valuemax', '464')
    expect(dividers[1]).toHaveAttribute('aria-valuemax', '524')
  })

  it('fits defaults into a narrow container while preserving every minimum', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 700,
      height: 700,
      left: 0,
      right: 900,
      top: 0,
      width: 900,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    renderPane()

    expect(screen.getByTestId('first-pane')).toHaveStyle({ width: '240px' })
    expect(screen.getByTestId('second-pane')).toHaveStyle({ width: '224px' })
    expect(screen.getByTestId('third-pane')).toHaveStyle({ width: '420px' })
  })

  it('clamps folder, note-list, and editor panes to their minimum widths', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 700,
      height: 700,
      left: 0,
      right: 900,
      top: 0,
      width: 900,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => undefined)
    vi.spyOn(HTMLElement.prototype, 'releasePointerCapture').mockImplementation(() => undefined)
    const { dividers } = renderPane()

    fireEvent.pointerDown(dividers[0], { clientX: 240, pointerId: 1 })
    fireEvent.pointerMove(dividers[0], { clientX: 20, pointerId: 1 })
    fireEvent.pointerUp(dividers[0], { pointerId: 1 })
    expect(screen.getByTestId('first-pane')).toHaveStyle({ width: '180px' })

    fireEvent.pointerDown(dividers[1], { clientX: 480, pointerId: 2 })
    fireEvent.pointerMove(dividers[1], { clientX: 200, pointerId: 2 })
    fireEvent.pointerUp(dividers[1], { pointerId: 2 })
    expect(screen.getByTestId('second-pane')).toHaveStyle({ width: '220px' })

    fireEvent.pointerDown(dividers[1], { clientX: 400, pointerId: 3 })
    fireEvent.pointerMove(dividers[1], { clientX: 900, pointerId: 3 })
    fireEvent.pointerUp(dividers[1], { pointerId: 3 })
    expect(screen.getByTestId('third-pane')).toHaveStyle({ width: '420px' })
  })

  it('preserves the folder width when the note-list divider reaches its maximum', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 700,
      height: 700,
      left: 0,
      right: 1000,
      top: 0,
      width: 1000,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const { dividers } = renderPane()

    fireEvent.pointerDown(dividers[1], { clientX: 548, pointerId: 9 })
    fireEvent.pointerMove(dividers[1], { clientX: 1000, pointerId: 9 })
    fireEvent.pointerUp(dividers[1], { pointerId: 9 })

    expect(screen.getByTestId('first-pane')).toHaveStyle({ width: '240px' })
    expect(screen.getByTestId('second-pane')).toHaveStyle({ width: '324px' })
    expect(dividers[0]).toHaveAttribute('aria-valuemax', '240')
    expect(dividers[1]).toHaveAttribute('aria-valuemax', '324')
  })

  it('restores the applicable default on double click and has no visible instructions', () => {
    const { dividers } = renderPane()

    fireEvent.keyDown(dividers[0], { key: 'ArrowRight' })
    fireEvent.doubleClick(dividers[0])

    expect(screen.getByTestId('first-pane')).toHaveStyle({ width: '240px' })
    expect(screen.queryByText(/拖动|调整.*宽度/)).not.toBeInTheDocument()
    expect(dividers[0]).toHaveAttribute('aria-orientation', 'vertical')
    expect(dividers[0]).toHaveAttribute('tabindex', '0')
  })

  it('collapses and restores a pane without losing its last resized width', () => {
    const { rerender } = render(
      <SplitPane defaultSizes={[240, 300]} minimumSizes={[180, 220, 420]} dividerLabels={labels} collapsed={[false, false]}>
        <div data-testid="first-pane" /><div data-testid="second-pane" /><div data-testid="third-pane" />
      </SplitPane>,
    )
    fireEvent.keyDown(screen.getAllByRole('separator')[0], { key: 'ArrowRight' })
    expect(screen.getByTestId('first-pane')).toHaveStyle({ width: '256px' })
    rerender(<SplitPane defaultSizes={[240, 300]} minimumSizes={[180, 220, 420]} dividerLabels={labels} collapsed={[true, false]}>
      <div data-testid="first-pane" /><div data-testid="second-pane" /><div data-testid="third-pane" />
    </SplitPane>)
    expect(screen.getByTestId('first-pane')).toHaveStyle({ width: '0px' })
    expect(screen.getByTestId('first-pane')).toHaveAttribute('aria-hidden', 'true')
    rerender(<SplitPane defaultSizes={[240, 300]} minimumSizes={[180, 220, 420]} dividerLabels={labels} collapsed={[false, false]}>
      <div data-testid="first-pane" /><div data-testid="second-pane" /><div data-testid="third-pane" />
    </SplitPane>)
    expect(screen.getByTestId('first-pane')).toHaveStyle({ width: '256px' })
  })

  it('removes a collapsed divider from layout and preserves its resized width through narrow measurements', () => {
    let width = 1200
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      bottom: 700,
      height: 700,
      left: 0,
      right: width,
      top: 0,
      width,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }))
    let notifyResize: ResizeObserverCallback | null = null
    class ResizeObserverDouble implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) { notifyResize = callback }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverDouble)
    const children = [
      <div data-testid="first-pane" key="first" />,
      <div data-testid="second-pane" key="second" />,
      <div data-testid="third-pane" key="third" />,
    ]
    const { rerender } = render(
      <SplitPane defaultSizes={[240, 300]} minimumSizes={[180, 220, 420]} dividerLabels={labels}>{children}</SplitPane>,
    )
    fireEvent.keyDown(screen.getAllByRole('separator')[0], { key: 'ArrowRight' })
    fireEvent.keyDown(screen.getAllByRole('separator')[0], { key: 'ArrowRight' })
    expect(screen.getByTestId('first-pane')).toHaveStyle({ width: '272px' })

    rerender(<SplitPane defaultSizes={[240, 300]} minimumSizes={[180, 220, 420]} dividerLabels={labels} collapsed={[true, false]}>{children}</SplitPane>)
    width = 700
    act(() => notifyResize?.([], {} as ResizeObserver))

    const collapsedDivider = screen.getAllByRole('separator', { hidden: true })[0]
    expect(collapsedDivider).toHaveStyle({ width: '0px' })
    expect(collapsedDivider).toHaveAttribute('tabindex', '-1')
    width = 1200
    rerender(<SplitPane defaultSizes={[240, 300]} minimumSizes={[180, 220, 420]} dividerLabels={labels}>{children}</SplitPane>)
    act(() => notifyResize?.([], {} as ResizeObserver))
    expect(screen.getByTestId('first-pane')).toHaveStyle({ width: '272px' })
  })
})
