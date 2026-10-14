import type { KeyboardEvent } from 'react'

/** Modal dialogs must retain keyboard focus until they close. */
export function dialogKeyboard(event: KeyboardEvent<HTMLElement>, close: () => void): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
    return
  }
  if (event.key !== 'Tab') return
  const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]'))
  const first = controls[0], last = controls[controls.length - 1]
  if ((event.shiftKey && event.target === first) || (!event.shiftKey && event.target === last)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first)?.focus()
  }
}
