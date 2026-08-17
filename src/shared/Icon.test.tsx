import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Icon, type IconName } from './Icon'

const REQUIRED_ICON_NAMES: readonly IconName[] = [
  'search',
  'settings',
  'plus',
  'folder',
  'inbox',
  'trash',
  'more',
  'source',
  'split',
  'preview',
  'collapse',
  'expand',
  'minimize',
  'maximize',
  'restore',
  'close',
]

describe('Icon', () => {
  afterEach(cleanup)

  it('keeps interface icons decorative inside labelled controls', () => {
    render(<button aria-label="打开设置"><Icon name="settings" /></button>)

    expect(screen.getByRole('button', { name: '打开设置' }))
      .toContainElement(screen.getByTestId('icon-settings'))
    expect(screen.getByTestId('icon-settings')).toHaveAttribute('aria-hidden', 'true')
  })

  it.each(REQUIRED_ICON_NAMES)('renders the approved %s glyph with the shared stroke treatment', (name) => {
    render(<Icon name={name} size={16} />)

    const icon = screen.getByTestId(`icon-${name}`)
    expect(icon).toHaveAttribute('width', '16')
    expect(icon).toHaveAttribute('height', '16')
    expect(icon).toHaveAttribute('viewBox', '0 0 24 24')
    expect(icon).toHaveAttribute('stroke-width', '1.75')
    expect(icon).toHaveAttribute('stroke-linecap', 'round')
    expect(icon).toHaveAttribute('stroke-linejoin', 'round')
  })
})
