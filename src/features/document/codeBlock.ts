import { createCodeLanguageControl } from '../editor/codeLanguageControl'
import CodeBlock from '@tiptap/extension-code-block'
import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { classHighlighter, highlightTree } from '@lezer/highlight'
import { codeLanguage } from '../editor/codeLanguages'

export const RichCodeBlock = CodeBlock.extend({
  addNodeView() {
    return props => {
      const dom = document.createElement('div')
      dom.className = 'rich-code-block'
      let current = props.node
      const control = createCodeLanguageControl({
        value: String(current.attrs.language ?? ''), disabled: !props.editor.isEditable,
        onCommit: (value, focusEditor) => {
          const position = props.getPos()
          if (!props.editor.isEditable || typeof position !== 'number') return
          if (String(current.attrs.language ?? '') === value) { if (focusEditor) props.editor.commands.focus(); return }
          const chain = props.editor.chain()
          if (focusEditor) chain.focus()
          chain.command(({tr}) => {
            tr.setNodeMarkup(position, undefined, {...current.attrs, language:value || null})
            return true
          }).run()
        },
      })
      const label = control.dom
      const pre = document.createElement('pre')
      const contentDOM = document.createElement('code')
      pre.append(contentDOM)
      dom.append(label, pre)
      const sync = () => {
        control.setDisabled(!props.editor.isEditable)
        const value = String(current.attrs.language ?? '')
        control.setValue(value)
        contentDOM.className=value ? 'language-'+value : ''
      }
      props.editor.on('update', sync)
      sync()
      return {
        dom, contentDOM,
        update(node) { if(node.type.name !== 'codeBlock') return false; current=node; sync(); return true },
        stopEvent(event) { return label.contains(event.target as Node) },
        ignoreMutation(mutation) { return mutation.type !== 'selection' && label.contains(mutation.target) },
        destroy() { control.destroy(); props.editor.off('update', sync) },
      }
    }
  },
})

export const RichCodeHighlight = Extension.create({
  name:'cayCodeHighlight',
  addProseMirrorPlugins() {
    // Immutable ProseMirror nodes retain their cached token ranges across unrelated edits.
    const tokens = new WeakMap<ProseMirrorNode, Array<{from:number;to:number;css:string}>>()
    const decorations = (doc:ProseMirrorNode) => {
      const ranges:Decoration[]=[]
      doc.descendants((node,position) => {
        if(node.type.name !== 'codeBlock') return
        let cached=tokens.get(node)
        if(!cached){
          cached=[]
          const language=codeLanguage(String(node.attrs.language??''))
          if(language)highlightTree(language.parser.parse(node.textContent),classHighlighter,(from,to,css)=>cached!.push({from,to,css}))
          tokens.set(node,cached)
        }
        for(const token of cached)ranges.push(Decoration.inline(position+1+token.from,position+1+token.to,{class:token.css}))
        return false
      })
      return DecorationSet.create(doc,ranges)
    }
    const key=new PluginKey<DecorationSet>('cayCodeHighlight')
    return [new Plugin({key,
      state:{init:(_,state)=>decorations(state.doc),apply:(tr,value)=>tr.docChanged?decorations(tr.doc):value},
      props:{decorations:state=>key.getState(state)},
    })]

  },
})
