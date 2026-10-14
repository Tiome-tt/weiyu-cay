/** Convert viewport pixels back to layout pixels under CSS zoom/scale. */
export function elementScale(element: HTMLElement | null | undefined): number {
  if (!element || element.offsetWidth <= 0) return 1
  const scale = element.getBoundingClientRect().width / element.offsetWidth
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}
