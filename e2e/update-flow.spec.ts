import { expect, test } from '@playwright/test'

test('checks and installs a simulated update only after explicit confirmation', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('button', { name: '打开设置' }).click()

  const check = page.getByRole('button', { name: '检查更新' })
  await expect(check).toBeVisible()
  await check.click()
  await expect(page.getByText('版本 0.1.1 可以安装。')).toBeVisible()

  await page.getByRole('button', { name: '下载并安装 0.1.1' }).click()
  await expect(page.getByText('更新已安装，重启后完成。')).toBeVisible()
  await page.getByRole('button', { name: '重启以完成更新' }).click()
})
