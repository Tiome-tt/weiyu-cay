import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

test('previews a supplied standalone quiz without copying it into the repository', async ({ page }) => {
  const sample = process.env.HTML_PREVIEW_SAMPLE
  test.skip(!sample, 'Optional local HTML acceptance sample')
  await page.route('http://html-preview.test/token', route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    headers: { 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; sandbox allow-scripts" },
    body: readFileSync(sample!, 'utf8'),
  }))
  await page.goto('/e2e/html-preview-fixture.html')
  const frame = page.frameLocator('iframe')
  await expect(frame.locator('#question')).toContainText('1')
  await expect(frame.locator('.option').first()).toBeVisible()
  await frame.locator('.option').first().click()
  if (await frame.locator('#submit').count()) await frame.locator('#submit').click()
  await expect(frame.locator('.feedback')).toBeVisible()
  await frame.locator('#next').click()
  await expect(frame.locator('#question')).toContainText('2')
})
test('HTML runs its own UI but cannot access the host, storage or network', async ({ page }) => {
  await page.route('http://html-preview.test/token', route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    headers: { 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; sandbox allow-scripts" },
    body: `<style>body{background:rgb(240,250,240)}</style><h1>交互题库</h1><button onclick="document.querySelector('output').textContent='回答正确'">选择答案</button><output></output><script>
    try{parent.document.body.innerHTML='unsafe'}catch{document.body.dataset.parent='blocked'}
    try{localStorage.setItem('unsafe','1')}catch{document.body.dataset.storage='blocked'}
    fetch('http://127.0.0.1:41737/private').then(()=>document.body.dataset.network='open').catch(()=>document.body.dataset.network='blocked');
    </script>`,
  }))
  await page.goto('/e2e/html-preview-fixture.html')
  const frame = page.frameLocator('iframe')
  await expect(frame.getByRole('heading', { name: '交互题库' })).toBeVisible()
  await frame.getByRole('button', { name: '选择答案' }).click()
  await expect(frame.locator('output')).toHaveText('回答正确')
  await expect(frame.locator('body')).toHaveAttribute('data-parent', 'blocked')
  await expect(frame.locator('body')).toHaveAttribute('data-storage', 'blocked')
  await expect(frame.locator('body')).toHaveAttribute('data-network', 'blocked')
})
