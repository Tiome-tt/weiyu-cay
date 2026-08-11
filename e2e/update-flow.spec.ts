import { expect, test } from '@playwright/test'

test('checks and installs a simulated update only after explicit confirmation', async ({ page }) => {
  await page.goto('/')

  const check = page.getByRole('button', { name: 'Check for updates' })
  await expect(check).toBeVisible()
  await check.click()
  await expect(page.getByText('Version 0.1.1 is ready to install.')).toBeVisible()

  await page.getByRole('button', { name: 'Download and install version 0.1.1' }).click()
  await expect(page.getByText('Update installed. Restart to finish.')).toBeVisible()
  await page.getByRole('button', { name: 'Restart to finish update' }).click()
})
