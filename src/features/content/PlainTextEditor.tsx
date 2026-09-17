import {forwardRef,useEffect,useImperativeHandle,useRef} from 'react'
import {Compartment,EditorState} from '@codemirror/state'
import {EditorView,keymap} from '@codemirror/view'
import {defaultKeymap,history,historyKeymap} from '@codemirror/commands'
export interface PlainTextEditorHandle { commitComposition():Promise<void>; focus():void }
export const PlainTextEditor=forwardRef<PlainTextEditorHandle,{value:string;onChange(value:string):void;editable?:boolean}>(function PlainTextEditor({value,onChange,editable=true},ref){
 const host=useRef<HTMLDivElement>(null)
 const view=useRef<EditorView|null>(null)
 const notify=useRef(onChange);notify.current=onChange
 const initial=useRef(value)
 const readonly=useRef(new Compartment())
 useEffect(()=>{
   const editor=new EditorView({parent:host.current!,state:EditorState.create({doc:initial.current,extensions:[
     history(),keymap.of([...defaultKeymap,...historyKeymap]),EditorView.lineWrapping,
     EditorView.contentAttributes.of({'aria-label':'纯文本正文',role:'textbox','aria-multiline':'true'}),
     readonly.current.of([EditorState.readOnly.of(!editable),EditorView.editable.of(editable)]),
     EditorView.updateListener.of(update=>{if(update.docChanged)notify.current(update.state.doc.toString())}),
     EditorView.theme({'&':{height:'100%',fontFamily:'var(--body-font)',fontSize:'var(--note-font-size)',backgroundColor:'var(--color-surface)',color:'var(--color-text)'},'.cm-content':{padding:'24px',minHeight:'100%'},'.cm-scroller':{overflow:'auto',fontFamily:'inherit'},'&.cm-focused':{outline:'none'}}),
   ]})})
   view.current=editor
   return()=>{editor.destroy();view.current=null}
   // Initial content is applied only once so ordinary saves preserve undo history.
 },[])
 useEffect(()=>{view.current?.dispatch({effects:readonly.current.reconfigure([EditorState.readOnly.of(!editable),EditorView.editable.of(editable)])})},[editable])
 useEffect(()=>{const editor=view.current;if(editor&&editor.state.doc.toString()!==value)editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:value}})},[value])
 useImperativeHandle(ref,()=>({focus:()=>view.current?.focus(),commitComposition:async()=>{
   const editor=view.current
   if(!editor)return
   if(editor.composing){editor.contentDOM.blur();await new Promise<void>(resolve=>setTimeout(resolve,0))}
   if(editor.composing)throw new Error('请先完成当前输入，再重试。')
   notify.current(editor.state.doc.toString())
 }}),[])
 return <div ref={host} style={{height:'100%'}}/>
})
