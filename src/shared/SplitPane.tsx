import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react'

const DIVIDER_WIDTH = 8
const KEYBOARD_STEP = 16

export type SplitPaneSizes = readonly [first: number, second: number]

interface SplitPaneProps {
  children: ReactNode
  defaultSizes: SplitPaneSizes
  minimumSizes: readonly [first: number, second: number, third: number]
  dividerLabels: readonly [first: string, second: string]
  proportions?: SplitPaneSizes
  onCommit?: (sizes: SplitPaneSizes, containerWidth: number) => void
  collapsed?: readonly [first: boolean, second: boolean]
}

interface DragState {
  divider: 0 | 1
  pointerId: number
}

type PaneElement = ReactElement<{
  className?: string
  style?: CSSProperties
  'aria-hidden'?: boolean
  inert?: boolean
}>

export function SplitPane({
  children,
  defaultSizes,
  minimumSizes,
  dividerLabels,
  proportions,
  onCommit,
  collapsed = [false, false],
}: SplitPaneProps) {
  const panes = Children.toArray(children)
  if (panes.length !== 3 || panes.some((pane) => !isValidElement(pane))) {
    throw new Error('SplitPane requires exactly three element children')
  }

  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const [sizes, setSizes] = useState<SplitPaneSizes>(defaultSizes)
  const [containerWidth, setContainerWidth] = useState(0)
  const sizesRef = useRef<SplitPaneSizes>(defaultSizes)

  useEffect(() => {
    sizesRef.current = sizes
  }, [sizes])

  useEffect(() => {
    if (!proportions || containerWidth <= 0) return
    const restored: SplitPaneSizes = [
      proportions[0] * containerWidth,
      proportions[1] * containerWidth,
    ]
    const next = fitIntoContainer(restored, minimumSizes, containerWidth, collapsed)
    sizesRef.current = next
    setSizes(next)
  }, [collapsed[0], collapsed[1], containerWidth, minimumSizes, proportions])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = () => {
      const width = container.getBoundingClientRect().width
      setContainerWidth(width)
      if (width <= 0) return
      setSizes((current) => {
        const next = fitIntoContainer(current, minimumSizes, width, collapsed)
        sizesRef.current = next
        return next[0] === current[0] && next[1] === current[1] ? current : next
      })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [collapsed[0], collapsed[1], minimumSizes])

  const measuredWidth = () => containerRef.current?.getBoundingClientRect().width ?? 0

  const clampSizes = (candidate: SplitPaneSizes, divider: 0 | 1): SplitPaneSizes => {
    const width = measuredWidth()
    let first = Math.max(minimumSizes[0], candidate[0])
    let second = Math.max(minimumSizes[1], candidate[1])
    if (width > 0) {
      const available = Math.max(0, width - visibleDividerWidth(0, collapsed) - visibleDividerWidth(1, collapsed))
      if (divider === 0) {
        first = Math.min(
          first,
          Math.max(minimumSizes[0], available - (collapsed[1] ? 0 : second) - minimumSizes[2]),
        )
      } else {
        second = Math.min(
          second,
          Math.max(minimumSizes[1], available - (collapsed[0] ? 0 : first) - minimumSizes[2]),
        )
      }
    }
    return [first, second]
  }

  const updateSizes = (candidate: SplitPaneSizes, divider: 0 | 1) => {
    const next = clampSizes(candidate, divider)
    sizesRef.current = next
    setSizes(next)
  }

  const commit = () => onCommit?.(sizesRef.current, measuredWidth())

  const startDrag = (divider: 0 | 1, event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { divider, pointerId: event.pointerId }
  }

  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const left = containerRef.current?.getBoundingClientRect().left ?? 0
    if (drag.divider === 0) {
      updateSizes([event.clientX - left, sizesRef.current[1]], drag.divider)
    } else {
      updateSizes(
        [sizesRef.current[0], event.clientX - left - sizesRef.current[0] - DIVIDER_WIDTH],
        drag.divider,
      )
    }
  }

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
    commit()
  }

  const resizeWithKeyboard = (divider: 0 | 1, event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const direction = event.key === 'ArrowRight' ? KEYBOARD_STEP : -KEYBOARD_STEP
    const current = sizesRef.current
    updateSizes(
      divider === 0
        ? [current[0] + direction, current[1]]
        : [current[0], current[1] + direction],
      divider,
    )
  }

  const finishKeyboardResize = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') commit()
  }

  const reset = (divider: 0 | 1) => {
    const current = sizesRef.current
    updateSizes(
      divider === 0 ? [defaultSizes[0], current[1]] : [current[0], defaultSizes[1]],
      divider,
    )
    queueMicrotask(commit)
  }

  const width = containerWidth
  const visibleFirst = collapsed[0] ? 0 : sizes[0]
  const visibleSecond = collapsed[1] ? 0 : sizes[1]
  const dividerWidth = visibleDividerWidth(0, collapsed) + visibleDividerWidth(1, collapsed)
  const thirdWidth = width > 0 ? Math.max(minimumSizes[2], width - dividerWidth - visibleFirst - visibleSecond) : undefined
  const paneWidths = [visibleFirst, visibleSecond, thirdWidth] as const

  return (
    <div ref={containerRef} className="split-pane">
      {panes.map((pane, index) => {
        const element = pane as PaneElement
        const paneStyle: CSSProperties = {
          ...element.props.style,
          flex: index === 2 && thirdWidth === undefined ? '1 1 auto' : '0 0 auto',
          minWidth: index < 2 && collapsed[index] ? '0px' : `${minimumSizes[index]}px`,
          width: paneWidths[index] === undefined ? undefined : `${paneWidths[index]}px`,
          overflow: index < 2 && collapsed[index] ? 'hidden' : element.props.style?.overflow,
        }
        const rendered = cloneElement(element, {
          className: [element.props.className, 'split-pane__pane'].filter(Boolean).join(' '),
          style: paneStyle,
          'aria-hidden': index < 2 && collapsed[index] ? true : undefined,
          inert: index < 2 && collapsed[index] ? true : undefined,
        })
        if (index === 2) return rendered
        const divider = index as 0 | 1
        const maximum = width > 0
          ? width - dividerWidth - minimumSizes[2] - (collapsed[divider === 0 ? 1 : 0] ? 0 : sizes[divider === 0 ? 1 : 0])
          : 10000
        const dividerStyle: CSSProperties | undefined = collapsed[divider]
          ? { flex: '0 0 0px', width: '0px', pointerEvents: 'none' }
          : undefined
        return (
          <span className="split-pane__segment" key={divider}>
            {rendered}
            <div
              className="split-pane__divider"
              style={dividerStyle}
              role="separator"
              aria-label={dividerLabels[divider]}
              aria-orientation="vertical"
              aria-valuemin={minimumSizes[divider]}
              aria-valuemax={Math.max(minimumSizes[divider], maximum)}
              aria-valuenow={sizes[divider]}
              aria-hidden={collapsed[divider] || undefined}
              tabIndex={collapsed[divider] ? -1 : 0}
              onPointerDown={(event) => startDrag(divider, event)}
              onPointerMove={moveDrag}
              onPointerUp={finishDrag}
              onPointerCancel={finishDrag}
              onKeyDown={(event) => resizeWithKeyboard(divider, event)}
              onKeyUp={finishKeyboardResize}
              onDoubleClick={() => reset(divider)}
            />
          </span>
        )
      })}
    </div>
  )
}

function fitIntoContainer(
  candidate: SplitPaneSizes,
  minimumSizes: readonly [first: number, second: number, third: number],
  width: number,
  collapsed: readonly [first: boolean, second: boolean],
): SplitPaneSizes {
  let first = Math.max(minimumSizes[0], candidate[0])
  let second = Math.max(minimumSizes[1], candidate[1])
  let overflow = (collapsed[0] ? 0 : first) + (collapsed[1] ? 0 : second) + minimumSizes[2]
    + visibleDividerWidth(0, collapsed) + visibleDividerWidth(1, collapsed) - width
  if (overflow > 0 && !collapsed[1]) {
    const secondReduction = Math.min(overflow, second - minimumSizes[1])
    second -= secondReduction
    overflow -= secondReduction
  }
  if (overflow > 0 && !collapsed[0]) {
    first -= Math.min(overflow, first - minimumSizes[0])
  }
  return [first, second]
}

function visibleDividerWidth(divider: 0 | 1, collapsed: readonly [first: boolean, second: boolean]) {
  return collapsed[divider] ? 0 : DIVIDER_WIDTH
}
