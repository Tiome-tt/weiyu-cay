import { expect, it } from 'vitest'
import { parseOfficePreview } from './officeXml'
it('reads docx paragraphs and xlsx cached cell values without executing markup', () => {
 expect(parseOfficePreview('docx',[{name:'word/document.xml',text:'<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>'}])[0].rows).toEqual([['正文']])
 expect(parseOfficePreview('xlsx',[{name:'xl/sharedStrings.xml',text:'<sst><si><t>公司</t></si></sst>'},{name:'xl/worksheets/sheet1.xml',text:'<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="C1"><v>42</v></c></row></sheetData></worksheet>'}])[0].rows).toEqual([['公司','','42']])
 expect(()=>parseOfficePreview('docx',[{name:'word/document.xml',text:'<!DOCTYPE a [<!ENTITY x "bad">]><a/>'}])).toThrow()
})
it('maps reordered workbook relationships and bounds malformed or oversized rows',()=>{
 const parts=[{name:'xl/workbook.xml',text:'<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="预算" r:id="rId2"/><sheet name="人员" r:id="rId1"/></sheets></workbook>'},{name:'xl/_rels/workbook.xml.rels',text:'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'},{name:'xl/worksheets/sheet1.xml',text:'<worksheet><row r="1"><c r="A1"><v>1</v></c></row></worksheet>'},{name:'xl/worksheets/sheet2.xml',text:'<worksheet><row r="-1"><c r="A1"><v>99</v></c></row><row r="1"><c r="A1"><v>2</v></c></row><row r="501"><c r="A501"><v>3</v></c></row></worksheet>'}]
 const result=parseOfficePreview('xlsx',parts)
 expect(result.map(section=>section.title)).toEqual(['预算','人员'])
 expect(result[0].rows).toEqual([['2']])
 expect(result[0].truncated).toBe(true)
})
it('preserves slide presentation order and inline Word tabs and line breaks',()=>{
 const slides=parseOfficePreview('pptx',[{name:'ppt/presentation.xml',text:'<p:presentation xmlns:p="p" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="second"/><p:sldId r:id="first"/></p:sldIdLst></p:presentation>'},{name:'ppt/_rels/presentation.xml.rels',text:'<Relationships><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="slides/slide2.xml"/></Relationships>'},{name:'ppt/slides/slide1.xml',text:'<slide><p><t>一</t></p></slide>'},{name:'ppt/slides/slide2.xml',text:'<slide><p><t>二</t></p></slide>'}])
 expect(slides.map(slide=>slide.rows[0][0])).toEqual(['二','一'])
 expect(parseOfficePreview('docx',[{name:'word/document.xml',text:'<document><body><p><r><t>A</t><tab/><t>B</t><br/><t>C</t></r></p></body></document>'}])[0].rows[0][0]).toBe('A\tB\nC')
})

it('reads only safe embedded slide pictures and excludes external relationships',()=>{
 const parts=[{name:'ppt/slides/slide1.xml',text:'<sld xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><pic><blip r:embed="image"/></pic><pic><blip r:embed="external"/></pic></sld>'},{name:'ppt/slides/_rels/slide1.xml.rels',text:'<Relationships><Relationship Id="image" Target="../media/image1.png"/><Relationship Id="external" TargetMode="External" Target="https://example.com/a.png"/></Relationships>'},{name:'ppt/media/image1.png',text:'data:image/png;base64,aGVsbG8='}]
 expect(parseOfficePreview('pptx',parts)[0].images).toEqual(['data:image/png;base64,aGVsbG8='])
})

it('retains cell columns when a real Excel worksheet skips empty row numbers',()=>{
 const sections=parseOfficePreview('xlsx',[{name:'xl/worksheets/sheet1.xml',text:'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>123</v></c></row><row r="3"><c r="B3"><v>456</v></c></row></sheetData></worksheet>'}])
 expect(sections[0].rows).toEqual([['123',''],['',''],['','456']])
})
