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
  'star',
]

describe('Icon', () => {
  afterEach(cleanup)

  it('keeps interface icons decorative inside labelled controls', () => {
    render(<button aria-label="打开设置"><Icon name="settings" /></button>)

    expect(screen.getByRole('button', { name: '打开设置' }))
      .toContainElement(screen.getByTestId('icon-settings'))
    expect(screen.getByTestId('icon-settings')).toHaveAttribute('aria-hidden', 'true')
  })

  it('renders settings as a cog with a center hole', () => {
    render(<Icon name="settings" />)

    const icon = screen.getByTestId('icon-settings')
    expect(icon.querySelector('circle')).toBeInTheDocument()
    expect(icon.querySelector('path')).toHaveAttribute('d', 'M19.43 12.98a7.7 7.7 0 0 0 .05-.98 7.7 7.7 0 0 0-.05-.98l2.11-1.65-2-3.46-2.49 1a7.6 7.6 0 0 0-1.69-.98L15 3.5h-4l-.38 2.43a7.6 7.6 0 0 0-1.69.98l-2.49-1-2 3.46 2.11 1.65a7.7 7.7 0 0 0-.05.98 7.7 7.7 0 0 0 .05.98l-2.11 1.65 2 3.46 2.49-1c.52.4 1.09.73 1.69.98L11 20.5h4l.38-2.43a7.6 7.6 0 0 0 1.69-.98l2.49 1 2-3.46-2.13-1.65Z')
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
