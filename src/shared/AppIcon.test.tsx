import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AppIcon } from './AppIcon'

describe('AppIcon', () => {
  afterEach(cleanup)

  it('renders the approved front-facing island layers at small size', () => {
    render(<AppIcon size={16} />)

    const icon = screen.getByTestId('weiyu-app-icon')
    expect(icon).toHaveAttribute('width', '16')
    expect(icon.querySelector('[data-layer="island"]')).not.toBeNull()
    expect(icon.querySelector('[data-layer="sand"]')).not.toBeNull()
    expect(icon.querySelector('[data-layer="waves"]')).not.toBeNull()
    expect(icon).toHaveAttribute('aria-hidden', 'true')
  })

  it('keeps the sand shore visible when the optional star detail is omitted at 16px', () => {
    render(<AppIcon size={16} />)

    const icon = screen.getByTestId('weiyu-app-icon')
    expect(icon.querySelector('[data-layer="sand"]')).toBeVisible()
    expect(icon.querySelector('[data-layer="star"]')).toBeNull()
  })

  it('exposes the star at larger sizes while preserving the same island layers', () => {
    render(<AppIcon size={32} decorative={false} />)

    const icon = screen.getByTestId('weiyu-app-icon')
    expect(icon).toHaveAttribute('role', 'img')
    expect(icon).toHaveAttribute('aria-label', '微屿')
    expect(icon.querySelector('[data-layer="star"]')).not.toBeNull()
    expect(icon.querySelector('[data-layer="waves"]')).not.toBeNull()
  })
})
