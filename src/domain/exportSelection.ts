import type { ExportSelection, FilePort } from './ports'

export function defaultExportName(title:string):string {
  const name=title.replace(/[<>:"/\\|?*]/g,'_').trim().replace(/[. ]+$/,'')||'Untitled'
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)||name.startsWith('.')?'_'+name:name
}

/** Change only the export destination; source titles and content stay authoritative. */
export function selectedExportPort(files:FilePort, selection?:ExportSelection):FilePort {
  if(!selection)return files
  return {
    chooseFiles:()=>files.chooseFiles(), importFiles:input=>files.importFiles(input),
    readFile:id=>files.readFile(id), readFileBytes:files.readFileBytes ? id=>files.readFileBytes!(id):undefined,
    readOfficeParts:files.readOfficeParts ? id=>files.readOfficeParts!(id):undefined,
    saveFileAs:id=>files.saveFileAs(id,selection), openFile:id=>files.openFile(id),
    savePdfExport:files.savePdfExport ? (id,bytes,title)=>files.savePdfExport!(id,bytes,title,selection):undefined,
    saveDocumentExport:files.saveDocumentExport ? (id,bytes,title)=>files.saveDocumentExport!(id,bytes,title,selection):undefined,
    saveTextExport:files.saveTextExport ? (id,text,title,format)=>files.saveTextExport!(id,text,title,format,selection):undefined,
    exportMarkdownNote:files.exportMarkdownNote ? (id,markdown)=>files.exportMarkdownNote!(id,markdown,selection):undefined,
  }
}
