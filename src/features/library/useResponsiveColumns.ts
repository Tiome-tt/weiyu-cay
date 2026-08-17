import { useLayoutEffect, useState, type RefObject } from 'react'

export interface EffectiveCollapsedColumns {
  folder: boolean
  noteList: boolean
}

const EXPANDED: EffectiveCollapsedColumns = { folder: false, noteList: false }

export function responsiveCollapse(width: number): EffectiveCollapsedColumns {
  return { folder: width < 1050, noteList: width < 850 }
}

export function useResponsiveColumns(containerRef: RefObject<HTMLElement | null>): EffectiveCollapsedColumns {
  const [collapsed, setCollapsed] = useState<EffectiveCollapsedColumns>(EXPANDED)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const measure = () => {
      const width = container.getBoundingClientRect().width
      if (width <= 0) return
      const next = responsiveCollapse(width)
      setCollapsed((current) => current.folder === next.folder && current.noteList === next.noteList ? current : next)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef])

  return collapsed
}
