import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

type Notification = { id: number; message: string }
const listeners = new Set<(notification: Notification) => void>()
let nextId = 0
const NotificationContext = createContext(false)

export function NotificationProvider({ children }: { children: ReactNode }) {
  return <NotificationContext.Provider value={true}><NotificationCenter />{children}</NotificationContext.Provider>
}

export function notifyError(message: string): void {
  const notification = { id: ++nextId, message }
  listeners.forEach((listener) => listener(notification))
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
  const [items, setItems] = useState<Notification[]>([])
  const dismiss = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), [])
  useEffect(() => {
    const add = (notification: Notification) => {
      setItems((current) => [...current.filter((item) => item.message !== notification.message).slice(-2), notification])
    }
    listeners.add(add)
    return () => { listeners.delete(add) }
  }, [])
  if (items.length === 0) return null
  return <div className="notification-center" aria-label="通知">
    {items.map((item) => <NotificationCard key={item.id} item={item} onDismiss={dismiss} />)}
  </div>
}

function NotificationCard({ item, onDismiss }: { item: Notification; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(item.id), 10_000)
    return () => window.clearTimeout(timer)
  }, [item.id, onDismiss])
  return <div className="notification-center__item" role="alert">
    <span className="notification-center__message">{item.message}</span>
    <button type="button" aria-label="关闭通知" onClick={() => onDismiss(item.id)}>×</button>
  </div>
}
