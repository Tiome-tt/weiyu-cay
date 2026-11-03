import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type NoticeAction = { label: string; onClick(): void; disabled?: boolean }
type Notification = { id: number; message: string; kind: 'alert' | 'status'; source?: number; removeSource?: number; action?: NoticeAction; focus?: boolean; onDismiss?(): void }
export type OperationNotice = { message: string; kind?: 'alert' | 'status'; action?: NoticeAction; focus?: boolean; onDismiss?(): void }
const listeners = new Set<(notification: Notification) => void>()
let nextId = 0
const NotificationContext = createContext(false)

export function NotificationProvider({ children }: { children: ReactNode }) {
  return <NotificationContext.Provider value={true}><NotificationCenter />{children}</NotificationContext.Provider>
}

export function notifyError(message: string): void {
  const notification: Notification = { id: ++nextId, message, kind: 'alert' }
  listeners.forEach((listener) => listener(notification))
}

export function OperationNotification({ notice }: { notice: OperationNotice | null | undefined }) {
  const hosted = useContext(NotificationContext)
  const source = useRef(++nextId)
  const lastNotified = useRef<OperationNotice | null>(null)
  const [local, setLocal] = useState<Notification | null>(null)
  const dismiss = useCallback(() => setLocal(null), [])
  useEffect(() => {
    if (notice && lastNotified.current !== notice) {
      const item: Notification = { ...notice, id: ++nextId, source:source.current, kind: notice.kind ?? 'status' }
      if (hosted) listeners.forEach(listener => listener(item))
      else setLocal(item)
    }
    if (!notice) {
      setLocal(null)
      if(hosted) listeners.forEach(listener=>listener({id:++nextId,message:'',kind:'status',removeSource:source.current}))
    }
    lastNotified.current = notice ?? null
  }, [notice, hosted])
  useEffect(()=>()=>{
    listeners.forEach(listener=>listener({id:++nextId,message:'',kind:'status',removeSource:source.current}))
    lastNotified.current=null
  },[])
  if (hosted || local === null) return null
  return createPortal(<div className="notification-center" aria-label="通知"><NotificationCard key={local.id} item={local} onDismiss={dismiss}/></div>,document.body)
}

export function ErrorNotification({ error }: { error: string | null | undefined }) {
  const hosted = useContext(NotificationContext)
  const lastNotified = useRef<string | null>(null)
  useEffect(() => {
    if (hosted && error && lastNotified.current !== error) notifyError(error)
    lastNotified.current = error ?? null
  }, [error, hosted])
  return hosted || !error ? null : <span role="alert">{error}</span>
}

export function NotificationCenter() {
  const stack=useRef<HTMLDivElement>(null)
  const [items, setItems] = useState<Notification[]>([])
  useEffect(()=>{if(stack.current)stack.current.scrollTop=stack.current.scrollHeight},[items])
  const dismiss = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), [])
  useEffect(() => {
    const add = (notification: Notification) => {
      if(notification.removeSource!==undefined) {setItems(current=>current.filter(item=>item.source!==notification.removeSource));return}
      setItems((current) => [...current.filter((item) => item.message !== notification.message || item.kind !== notification.kind).filter(item=>notification.source===undefined || item.source!==notification.source), notification])
    }
    listeners.add(add)
    return () => { listeners.delete(add) }
  }, [])
  if (items.length === 0) return null
  return <div ref={stack} className="notification-center" aria-label="通知">
    {items.map((item) => <NotificationCard key={item.id} item={item} onDismiss={dismiss} />)}
  </div>
}

function NotificationCard({ item, onDismiss }: { item: Notification; onDismiss: (id: number) => void }) {
  const message=useRef<HTMLSpanElement>(null)
  useEffect(()=>{if(item.focus)message.current?.focus()},[item.id,item.focus])
  useEffect(() => {
    const timer = window.setTimeout(() => { item.onDismiss?.(); onDismiss(item.id) }, 10_000)
    return () => window.clearTimeout(timer)
  }, [item.id, item.onDismiss, onDismiss])
  return <div className={`notification-center__item notification-center__item--${item.kind}`} role={item.kind}>
    <span ref={message} tabIndex={item.focus?-1:undefined} className="notification-center__message">{item.message}</span>
    {item.action && <button className="notification-center__action" type="button" disabled={item.action.disabled} onClick={item.action.onClick}>{item.action.label}</button>}
    <button type="button" aria-label="关闭通知" onClick={() => {item.onDismiss?.();onDismiss(item.id)}}>×</button>
  </div>
}
