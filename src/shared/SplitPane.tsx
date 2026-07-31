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
  onCommit?: (sizes: SplitPaneSizes, containerWidth: number) => void
}

interface DragState {
  divider: 0 | 1
  pointerId: number
}

type PaneElement = ReactElement<{ className?: string; style?: CSSProperties }>

export function SplitPane({
  children,
  defaultSizes,
  minimumSizes,
  dividerLabels,
  onCommit,
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

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = () => {
      const width = container.getBoundingClientRect().width
      setContainerWidth(width)
      if (width <= 0) return
      setSizes((current) => {
        const next = fitIntoContainer(current, minimumSizes, width)
        sizesRef.current = next
        return next[0] === current[0] && next[1] === current[1] ? current : next
      })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const measuredWidth = () => containerRef.current?.getBoundingClientRect().width ?? 0

  const clampSizes = (candidate: SplitPaneSizes): SplitPaneSizes => {
    const width = measuredWidth()
    let first = Math.max(minimumSizes[0], candidate[0])
    let second = Math.max(minimumSizes[1], candidate[1])
    if (width > 0) {
      const available = Math.max(0, width - DIVIDER_WIDTH * 2)
      first = Math.min(first, Math.max(minimumSizes[0], available - second - minimumSizes[2]))
      second = Math.min(second, Math.max(minimumSizes[1], available - first - minimumSizes[2]))
    }
    return [first, second]
  }

  const updateSizes = (candidate: SplitPaneSizes) => {
    const next = clampSizes(candidate)
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
      updateSizes([event.clientX - left, sizesRef.current[1]])
    } else {
      updateSizes([
        sizesRef.current[0],
        event.clientX - left - sizesRef.current[0] - DIVIDER_WIDTH,
      ])
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
    updateSizes(divider === 0 ? [current[0] + direction, current[1]] : [current[0], current[1] + direction])
  }

  const finishKeyboardResize = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') commit()
  }

  const reset = (divider: 0 | 1) => {
    const current = sizesRef.current
    updateSizes(divider === 0 ? [defaultSizes[0], current[1]] : [current[0], defaultSizes[1]])
    queueMicrotask(commit)
  }

  const width = containerWidth
  const thirdWidth = width > 0 ? Math.max(minimumSizes[2], width - DIVIDER_WIDTH * 2 - sizes[0] - sizes[1]) : undefined
  const paneWidths = [sizes[0], sizes[1], thirdWidth] as const

  return (
    <div ref={containerRef} className="split-pane">
      {panes.map((pane, index) => {
        const element = pane as PaneElement
        const paneStyle: CSSProperties = {
          ...element.props.style,
          flex: index === 2 && thirdWidth === undefined ? '1 1 auto' : '0 0 auto',
          minWidth: `${minimumSizes[index]}px`,
          width: paneWidths[index] === undefined ? undefined : `${paneWidths[index]}px`,
        }
        const rendered = cloneElement(element, {
          className: [element.props.className, 'split-pane__pane'].filter(Boolean).join(' '),
          style: paneStyle,
        })
        if (index === 2) return rendered
        const divider = index as 0 | 1
        const maximum = width > 0
          ? width - DIVIDER_WIDTH * 2 - minimumSizes[2] - sizes[divider === 0 ? 1 : 0]
          : 10000
        return (
          <span className="split-pane__segment" key={divider}>
            {rendered}
            <div
              className="split-pane__divider"
              role="separator"
              aria-label={dividerLabels[divider]}
              aria-orientation="vertical"
              aria-valuemin={minimumSizes[divider]}
              aria-valuemax={Math.max(minimumSizes[divider], maximum)}
              aria-valuenow={sizes[divider]}
              tabIndex={0}
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
): SplitPaneSizes {
  let first = Math.max(minimumSizes[0], candidate[0])
  let second = Math.max(minimumSizes[1], candidate[1])
  let overflow = first + second + minimumSizes[2] + DIVIDER_WIDTH * 2 - width
  if (overflow > 0) {
    const secondReduction = Math.min(overflow, second - minimumSizes[1])
    second -= secondReduction
    overflow -= secondReduction
  }
  if (overflow > 0) {
    first -= Math.min(overflow, first - minimumSizes[0])
  }
  return [first, second]
}
