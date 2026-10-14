import { expect, it, vi } from 'vitest'
import { officeProjection, convertManagedFile } from './fileConversion'
it('builds inert Office export projections and refuses silently truncated spreadsheets',()=>{
 const projection=officeProjection([{title:'Sheet',kind:'table',rows:[['<script>alert(1)</script>','42']]}])
 expect(projection.element.querySelector('script')).toBeNull()
 expect(projection.text).toContain('<script>alert(1)</script>\t42')
 expect(projection.element.querySelector('td')?.textContent).toContain('<script>')
 expect(()=>officeProjection([{title:'',kind:'table',rows:[],truncated:true}])).toThrow()
})

import { note } from '../../test/fakes'
import type { FilePort } from '../../domain/ports'
it('converts a real PNG into PDF bytes without replacing the original attachment',async()=>{
 const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='),character=>character.charCodeAt(0))
 const savePdfExport=vi.fn<(id:ReturnType<typeof note>['id'],bytes:Uint8Array,title:string)=>Promise<boolean>>().mockResolvedValue(true)
 const files:FilePort={chooseFiles:async()=>[],importFiles:async()=>({imported:[],failed:[]}),readFile:async()=>({mediaType:'image/png',bytes:png}),saveFileAs:vi.fn(async()=>true),openFile:async()=>{},savePdfExport}
 const source={...note(''),content:{type:'file' as const,file:{storageName:'p',originalName:'photo.png',mediaType:'image/png',size:png.length,sha256:''}}}
 expect(await convertManagedFile(source,'pdf',files)).toBe(true)
 expect(new TextDecoder().decode(savePdfExport.mock.calls[0][1].slice(0,5))).toBe('%PDF-')
 expect(files.saveFileAs).not.toHaveBeenCalled()
})
