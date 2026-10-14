import '@testing-library/jest-dom/vitest'
import {render,screen,cleanup} from '@testing-library/react'
import {afterEach,it,expect} from 'vitest'
import {OfficePreview} from './OfficePreview'
import {note} from '../../test/fakes'
afterEach(cleanup)
it('keeps empty spreadsheets and slides blank without isolated titles',async()=>{
 const files={chooseFiles:async()=>[],importFiles:async()=>({imported:[],failed:[]}),readFile:async()=>({mediaType:'',bytes:new Uint8Array()}),saveFileAs:async()=>true,openFile:async()=>{},readOfficeParts:async()=>[{name:'xl/workbook.xml',text:'<workbook><sheets><sheet name="Sheet1"/></sheets></workbook>'},{name:'xl/worksheets/sheet1.xml',text:'<worksheet><row><c r="A1" s="1"/></row></worksheet>'}]}
 const {container}=render(<OfficePreview noteId={note('').id} extension="xlsx" files={files} empty={false}/>)
 await new Promise(resolve=>setTimeout(resolve,30))
 expect(screen.queryByText('Sheet1')).toBeNull()
 expect(container.querySelector('table')).toBeNull()
})
