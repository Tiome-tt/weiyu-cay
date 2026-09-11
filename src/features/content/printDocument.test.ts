import {expect,it} from 'vitest'
import {printableClone} from './printDocument'
it('keeps table spans and visible text while removing editor controls and active content',()=>{
 const source=document.createElement('article')
 source.innerHTML='<h1>微屿</h1><table><tr><td colspan="2" data-background-color="green">合并</td></tr></table><button>工具</button><script>alert(1)</script><img src="https://example.com/a" onerror="alert(1)">'
 const result=printableClone(source)
 expect(result.querySelector('td')?.colSpan).toBe(2)
 expect(result.textContent).toContain('合并')
 expect(result.querySelector('script,button')).toBeNull()
 expect(result.querySelector('img')?.hasAttribute('src')).toBe(false)
 expect(result.querySelector('img')?.hasAttribute('onerror')).toBe(false)
})
