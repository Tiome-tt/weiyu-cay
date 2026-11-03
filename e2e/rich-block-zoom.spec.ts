import { expect, test } from '@playwright/test'

test('zoomed rich block numbers track content and remain clickable after scrolling', async ({ page }) => {
  await page.goto('/e2e/v114-preferences-fixture.html?mode=keyboard-rich')
  const surface = page.locator('.rich-document__surface')
  const body = page.getByRole('textbox', { name: '文档正文' })
  const controls = page.locator('.rich-document__block-controls')
  const plus = controls.getByRole('button', { name: '添加内容块' })
  let current = 1
  for (const scale of [1, 1.5, 2, 0.5]) {
    while (Math.abs(current - scale) > 0.01) {
      const deltaY = current < scale ? -100 : 100
      await surface.dispatchEvent('wheel', { ctrlKey: true, deltaY })
      current = Math.round((current + (deltaY < 0 ? 0.1 : -0.1)) * 10) / 10
    }
    await expect.poll(() => surface.evaluate(element => getComputedStyle(element).zoom)).toBe(String(scale))
    const block = body.locator('[data-block-number]').nth(12)
    await block.scrollIntoViewIfNeeded()
    await block.hover()
    await expect(controls).toHaveClass(/is-visible/)
    const text = (await block.boundingBox())!
    const gutter = (await controls.boundingBox())!
    const button = (await plus.boundingBox())!
    const number = (await controls.locator('.rich-document__block-number').boundingBox())!
    expect(Math.abs(gutter.y - text.y)).toBeLessThan(2)
    expect(gutter.x + gutter.width).toBeLessThan(text.x)
    expect(text.x - gutter.x).toBeLessThan(75 * scale)
    expect(Math.abs(number.y + number.height / 2 - button.y - button.height / 2)).toBeLessThan(1)
    expect(Math.abs(button.height - 24 * scale)).toBeLessThan(1)
  }
  const box = (await plus.boundingBox())!
  const block = body.locator('[data-block-number]').nth(12)
  const text = (await block.boundingBox())!
  await page.mouse.move(text.x + 2, box.y + box.height / 2)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 })
  await plus.click()
  await expect(page.getByRole('menu', { name: '插入内容' })).toBeVisible()
  await page.screenshot({ path: 'test-results/rich-block-zoom.png' })
})
