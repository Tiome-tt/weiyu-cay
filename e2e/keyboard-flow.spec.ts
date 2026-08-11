import { expect, type Locator, type Page, test } from '@playwright/test'

async function tabTo(page: Page, target: Locator, limit = 120) {
  for (let index = 0; index < limit; index += 1) {
    if (await target.evaluate((element) => element === document.activeElement).catch(() => false)) return
    await page.keyboard.press('Tab')
  }
  throw new Error(`keyboard focus did not reach ${await target.getAttribute('aria-label') ?? await target.textContent()}`)
}

async function activate(page: Page, target: Locator) {
  await tabTo(page, target)
  await page.keyboard.press('Enter')
}

test('completes the primary application flow with keyboard input only', async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto('/')
  await tabTo(page, page.getByRole('treeitem', { name: '未归档笔记' }))
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await activate(page, page.getByRole('button', { name: '新建笔记' }))
  const newTitle = page.getByRole('textbox', { name: '新笔记标题' })
  await tabTo(page, newTitle)
  await page.keyboard.type('键盘流程')
  await page.keyboard.press('Enter')
  const editor = page.getByRole('textbox', { name: 'Markdown source' })
  await tabTo(page, editor)
  await page.keyboard.type('# 键盘流程\n\n')
  const linkTarget = page.getByRole('combobox', { name: '内部链接目标' })
  await expect(linkTarget.locator('option:checked')).toHaveText('用户认证')
  await activate(page, page.getByRole('button', { name: '插入内部链接' }))
  await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible()

  const search = page.getByRole('searchbox', { name: '搜索笔记' })
  await tabTo(page, search)
  await page.keyboard.type('键盘流程')
  await page.keyboard.press('Enter')
  await activate(page, page.locator('.search-results button').filter({ hasText: '键盘流程' }))
  await activate(page, page.getByRole('button', { name: '预览视图' }))
  await activate(page, page.getByRole('link', { name: '用户认证' }))
  await expect(page.getByRole('heading', { name: '用户认证' })).toBeVisible()

  await tabTo(page, page.locator('[role="treeitem"][tabindex="0"]'))
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  const firstCapture = page.getByRole('checkbox').first()
  await tabTo(page, firstCapture)
  await page.keyboard.press('Space')
  await activate(page, page.getByRole('button', { name: '转为笔记' }))
  await activate(page, page.getByRole('button', { name: '确认转换' }))
  await expect(page.getByRole('checkbox')).toHaveCount(1)

  await tabTo(page, page.locator('[role="treeitem"][tabindex="0"]'))
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await activate(page, page.locator('.search-results button').filter({ hasText: '键盘流程' }))
  page.once('dialog', (dialog) => dialog.accept())
  await activate(page, page.locator('.note-list__row:has(.note-card[aria-current="true"]) .note-list__delete'))
  await tabTo(page, page.locator('[role="treeitem"][tabindex="0"]'))
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  const trashed = page.getByRole('checkbox', { name: '选择 键盘流程' })
  await tabTo(page, trashed)
  await page.keyboard.press('Space')
  await activate(page, page.getByRole('button', { name: '恢复所选' }))
  await expect(trashed).toHaveCount(0)

  await activate(page, page.getByRole('button', { name: '打开设置' }))
  const theme = page.getByRole('combobox', { name: '主题' })
  await tabTo(page, theme)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await activate(page, page.getByRole('button', { name: 'Export complete library' }))
  await expect(page.getByRole('status').filter({ hasText: /Exported .* notes/ })).toBeVisible()
})
