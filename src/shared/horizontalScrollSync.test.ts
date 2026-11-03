import {expect,it,vi} from 'vitest'
import {linkHorizontalScroll} from './horizontalScrollSync'
it('ignores queued mirrored events so fractional scroll values cannot pull the dragged thumb backwards',()=>{
 const first=document.createElement('div'),second=document.createElement('div'),changed=vi.fn()
 let rounded=0
 Object.defineProperty(second,'scrollLeft',{get:()=>rounded,set:(value:number)=>{rounded=Math.round(value)}})
 const stop=linkHorizontalScroll(first,second,changed)
 first.scrollLeft=25.4;first.dispatchEvent(new Event('scroll'))
 expect(second.scrollLeft).toBe(25)
 second.dispatchEvent(new Event('scroll'))
 expect(first.scrollLeft).toBe(25.4)
 expect(changed).toHaveBeenCalledTimes(1)
 second.scrollLeft=60;second.dispatchEvent(new Event('scroll'))
 expect(first.scrollLeft).toBe(60)
 stop()
 first.scrollLeft=80;first.dispatchEvent(new Event('scroll'))
 expect(second.scrollLeft).toBe(60)
})
