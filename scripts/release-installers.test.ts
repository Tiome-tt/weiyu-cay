import {expect,it} from 'vitest'
import {installerMatrix,validateInstallers} from './release-installers'
it('requires exactly one installer per platform and full UI language, while allowing updater auxiliaries',()=>{
 const names=installerMatrix.map(item=>`weiyu-cay_1.1.5_${item.suffix}`)
 expect(names).toHaveLength(4)
 expect(()=>validateInstallers([...names,'latest.json','SHA256SUMS','Cay.app.tar.gz','Cay.app.tar.gz.sig'],'1.1.5')).not.toThrow()
 expect(()=>validateInstallers(names.slice(1),'1.1.5')).toThrow()
 expect(()=>validateInstallers([...names,'legacy.msi'],'1.1.5')).toThrow()
})
