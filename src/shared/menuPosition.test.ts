import {expect,it} from 'vitest'
import {fitMenuToBounds} from './menuPosition'
it('keeps the complete menu above a bottom-edge click and inside narrow bounds',()=>{
 const result=fitMenuToBounds({x:980,y:740,width:160,height:420,left:0,top:30,right:1000,bottom:760})
 expect(result.x+160).toBeLessThanOrEqual(992)
 expect(result.y+420).toBeLessThanOrEqual(752)
 expect(result.y).toBeLessThan(740)
})
