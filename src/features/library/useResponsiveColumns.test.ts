import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { responsiveCollapse, useResponsiveColumns } from './useResponsiveColumns'

let notifyResize: ResizeObserverCallback | null = null

class ResizeObserverDouble implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    notifyResize = callback
  }

  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  notifyResize = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('responsive library columns', () => {
  it.each([
    [1180, { folder: false, noteList: false }],
    [1050, { folder: false, noteList: false }],
    [1000, { folder: true, noteList: false }],
    [850, { folder: true, noteList: false }],
    [820, { folder: true, noteList: true }],
  ])('derives automatic collapse at %ipx', (width, expected) => {
    expect(responsiveCollapse(width)).toEqual(expected)
  })

  it('observes container width without producing a persisted preference', () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverDouble)
    let width = 1180
    const container = document.createElement('div')
    vi.spyOn(container, 'getBoundingClientRect').mockImplementation(() => ({
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
    const containerRef = { current: container }
    const { result } = renderHook(() => useResponsiveColumns(containerRef))
    expect(result.current).toEqual({ folder: false, noteList: false })

    width = 820
    act(() => notifyResize?.([], {} as ResizeObserver))
    expect(result.current).toEqual({ folder: true, noteList: true })
  })
})
