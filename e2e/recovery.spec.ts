import { expect, test } from '@playwright/test'

test('promotes a simulated interrupted-save candidate on reopen', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('simple-notes-e2e-state-v1')!) as {
      notes: Array<Record<string, unknown>>
    }
    const existing = state.notes[0]
    localStorage.setItem('simple-notes-e2e-interrupted-save', JSON.stringify({
      ...existing,
      title: '恢复的中断保存',
      markdown: '# 恢复的中断保存\n\n候选正文',
      revision: Number(existing.revision) + 1,
    }))
  })

  await page.reload()

  await expect(page.getByText('已恢复 1 篇笔记并重建本地索引')).toBeVisible()
  await page.getByRole('treeitem', { name: '项目' }).click()
  await page.locator('.note-card').filter({ hasText: '恢复的中断保存' }).click()
  await expect(page.getByRole('heading', { name: '恢复的中断保存' })).toBeVisible()
})
