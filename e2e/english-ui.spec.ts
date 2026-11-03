import {expect,test} from '@playwright/test'
test.skip(process.env.VITE_CAY_LOCALE!=='en-US','English build checks run with VITE_CAY_LOCALE=en-US')
test('all settings categories use English copy',async({page})=>{
 await page.goto('/e2e/english-ui-fixture.html')
 for(const label of ['General','System','Shortcuts','Storage','AI']){
  await page.getByRole('tab',{name:label,exact:true}).click()
  await expect(page.getByRole('button',{name:'Done',exact:true})).toBeVisible()
  const copy=await page.getByRole('dialog').innerText()
  expect(copy).not.toMatch(/[\u4e00-\u9fff]/)
 }
 await page.screenshot({path:'test-results/english-settings.png'})
})
test('English Markdown controls preserve Chinese note text and cell focus',async({page})=>{
 await page.goto('/e2e/english-ui-fixture.html?mode=markdown')
 const input=page.getByRole('textbox',{name:'Row 2, column 1',exact:true})
 await expect(input).toHaveValue('原文')
 await input.click();await input.fill('保留原文');await input.press('Tab')
 await expect(page.getByRole('textbox',{name:'Row 2, column 2',exact:true})).toBeFocused()
 await expect(page.locator('.cm-content')).toContainText('中文用户内容')
})
test('rich document menus and table tools use English',async({page})=>{
 await page.goto('/e2e/english-ui-fixture.html?mode=rich')
 await page.getByRole('textbox',{name:'Document content'}).click({button:'right'})
 const menu=page.getByRole('menu',{name:'Content actions'})
 expect(await menu.innerText()).not.toMatch(/[\u4e00-\u9fff]/)
 await menu.getByRole('menuitem',{name:'Table',exact:true}).click()
 await page.getByRole('gridcell',{name:'2 rows, 2 columns',exact:true}).click()
 await expect(page.locator('.tiptap table')).toBeVisible()
 await expect(page.getByRole('toolbar',{name:'Table tools'})).toBeVisible()
})
