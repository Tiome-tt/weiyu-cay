import { expect, it } from 'vitest'
import { floatingHeaderTop } from './floatingTableHeaders'
it('floats only after the original header has left view and stops at the table bottom',()=>{
 expect(floatingHeaderTop(100,600,50,40)).toBeNull()
 expect(floatingHeaderTop(-100,600,50,40)).toBe(50)
 expect(floatingHeaderTop(-100,70,50,40)).toBe(30)
 expect(floatingHeaderTop(-100,40,50,40)).toBeNull()
})
