import { expect, test } from '@playwright/test'

test('Enter before a rich heading marker keeps the entire title together', async ({ page }) => {
  await page.goto('/e2e/rich-heading-fixture.html')
  const heading = page.locator('[data-rich-heading]')
  await expect(heading).toHaveCount(1)
  await heading.click()
  const marker = heading.locator('.rich-document__heading-marker')
  await expect(marker).toBeVisible()
  await marker.click({ position: { x: 2, y: 8 } })
  await page.keyboard.press('Enter')

  await expect(heading).toHaveCount(1)
  await expect(heading.locator('.rich-document__heading-content')).toHaveText('Self-Attention')
  await expect(page.locator('.rich-document__content > p').filter({ hasText: 'Self' })).toHaveCount(0)
  await expect(page.locator('.rich-document__content > p').nth(1)).toBeEmpty()
})
test('Enter after the first click at the leading edge keeps the heading intact', async ({ page }) => {
  await page.goto('/e2e/rich-heading-fixture.html')
  const heading = page.locator('[data-rich-heading]')
  await expect(heading).toHaveCount(1)
  await heading.click({ position: { x: 2, y: 8 } })
  await page.keyboard.press('Enter')

  await expect(heading).toHaveCount(1)
  await expect(heading.locator('.rich-document__heading-content')).toHaveText('Self-Attention')
  await expect(page.locator('.rich-document__content > p').nth(1)).toBeEmpty()
})