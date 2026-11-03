import { expect,it,vi } from 'vitest'
import { rememberPreview } from './previewByteCache'
it('bounds retained preview bytes and does not duplicate oversized payloads',()=>{
 const cache=new Map<string,{mediaType:string;bytes:Uint8Array}>()
 const large=new Uint8Array(33*1024*1024),copy=vi.spyOn(large,'slice')
 rememberPreview(cache,'large',{mediaType:'application/pdf',bytes:large})
 expect(copy).not.toHaveBeenCalled();expect(cache.size).toBe(0)
 for(let n=0;n<3;n++)rememberPreview(cache,String(n),{mediaType:'application/pdf',bytes:new Uint8Array(12*1024*1024)})
 expect(cache.size).toBe(2)
})
