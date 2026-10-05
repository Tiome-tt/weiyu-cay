import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteId } from '../../domain/model'
import { richEditorExtensions } from './extensions'

const NOTE_ID = '019c0000-0000-7000-8000-000000000001' as NoteId
const IMAGE_PATH = 'assets/screenshot-019c0000-0000-7000-8000-000000000009.png'

beforeEach(() => {
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:managed-image'),
    revokeObjectURL: vi.fn(),
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('managed rich images', () => {
  it('does not create an object URL after the node view is destroyed', async () => {
    let finishRead!: (value: { mediaType: string; bytes: Uint8Array }) => void
    const readImage = vi.fn(() => new Promise<{ mediaType: string; bytes: Uint8Array }>((resolve) => { finishRead = resolve }))
    const element = document.createElement('div')
    const editor = new Editor({
      element,
      extensions: richEditorExtensions({ noteId: NOTE_ID, assetReader: { readImage } }),
      content: { type: 'doc', content: [{ type: 'image', attrs: { src: IMAGE_PATH } }] },
    })
    await new Promise((resolve) => setTimeout(resolve, 16))
    editor.destroy()
    finishRead({ mediaType: 'image/png', bytes: new Uint8Array([1]) })
    await Promise.resolve()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('revokes a created object URL when the node view is destroyed', async () => {
    const element = document.createElement('div')
    const editor = new Editor({
      element,
      extensions: richEditorExtensions({
        noteId: NOTE_ID,
        assetReader: { readImage: vi.fn().mockResolvedValue({ mediaType: 'image/png', bytes: new Uint8Array([1]) }) },
      }),
      content: { type: 'doc', content: [{ type: 'image', attrs: { src: IMAGE_PATH } }] },
    })
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled())
    const created = vi.mocked(URL.createObjectURL).mock.calls.length
    editor.destroy()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(created)
  })

  it('loads managed images without waiting for an intersection callback', async () => {
    const observe = vi.fn()
    class NeverIntersects {
      observe = observe
      disconnect = vi.fn()
    }
    vi.stubGlobal('IntersectionObserver', NeverIntersects)
    const readImage = vi.fn().mockResolvedValue({ mediaType: 'image/png', bytes: new Uint8Array([1]) })
    const element = document.createElement('div')
    const editor = new Editor({
      element,
      extensions: richEditorExtensions({ noteId: NOTE_ID, assetReader: { readImage } }),
      content: { type: 'doc', content: [{ type: 'image', attrs: { src: IMAGE_PATH } }] },
    })

    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled())
    expect(readImage).toHaveBeenCalledOnce()
    editor.destroy()
  })
})

it('loads a newly inserted image while an earlier node is still loading',async()=>{
 let finish!:()=>void
 const gate=new Promise<void>(resolve=>{finish=resolve})
 const nextPath='assets/screenshot-019c0000-0000-7000-8000-000000000010.png'
 const readImage=vi.fn(async({relativePath}:{relativePath:string})=>{if(relativePath===IMAGE_PATH)await gate;return {mediaType:'image/png',bytes:new Uint8Array([1])}})
 const element=document.createElement('div')
 const editor=new Editor({element,extensions:richEditorExtensions({noteId:NOTE_ID,assetReader:{readImage}}),content:{type:'doc',content:[{type:'image',attrs:{src:IMAGE_PATH}}]}})
 await vi.waitFor(()=>expect(readImage).toHaveBeenCalledOnce())
 editor.commands.insertContentAt(editor.state.doc.content.size,{type:'image',attrs:{src:nextPath}})
 finish()
 await vi.waitFor(()=>expect(URL.createObjectURL).toHaveBeenCalledTimes(2))
 expect(element.querySelectorAll('img[src="blob:managed-image"]')).toHaveLength(2)
 expect(editor.getJSON().content?.filter(node=>node.type==='image')).toHaveLength(2)
 editor.destroy()
})
