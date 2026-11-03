import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { ErrorNotification, NotificationCenter, NotificationProvider, notifyError, OperationNotification } from './notifications'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('stacks all results in arrival order and keeps undo actions in the same host', () => {
  const undo = vi.fn()
  const { rerender } = render(<NotificationProvider><OperationNotification notice={{message:'已删除',action:{label:'撤销删除',onClick:undo}}}/></NotificationProvider>)
  act(() => { for (const text of ['甲','乙','丙','丁']) notifyError(text) })
  expect(screen.getAllByRole('alert')).toHaveLength(4)
  expect(screen.getByRole('button', {name:'撤销删除'}).closest('.notification-center')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', {name:'撤销删除'}))
  expect(undo).toHaveBeenCalledOnce()
  expect(screen.getAllByRole('alert')[3]).toHaveTextContent('丁')
  rerender(<NotificationProvider><OperationNotification notice={null}/></NotificationProvider>)
  expect(screen.queryByRole('button', {name:'撤销删除'})).not.toBeInTheDocument()
})

it('routes a component error through the app host without adding an inline alert', () => {
  render(<NotificationProvider><section data-testid="editor"><ErrorNotification error="链接地址无效" /></section></NotificationProvider>)
  expect(screen.getByRole('alert')).toHaveTextContent('链接地址无效')
  expect(screen.getByTestId('editor')).toBeEmptyDOMElement()
})

it('does not duplicate an initial error in development StrictMode', () => {
  render(<StrictMode><NotificationProvider><ErrorNotification error="保存失败" /></NotificationProvider></StrictMode>)
  expect(screen.getAllByRole('alert')).toHaveLength(1)
})

it('shows operation errors at the bottom right, allows dismissal, and expires after ten seconds', () => {
  vi.useFakeTimers()
  render(<NotificationCenter />)
  act(() => notifyError('请输入完整的 http 或 https 链接。'))
  expect(screen.getByRole('alert')).toHaveTextContent('请输入完整的 http 或 https 链接。')
  expect(screen.getByRole('alert').closest('.notification-center')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '关闭通知' }))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  act(() => notifyError('图片未能保存，请重试。'))
  act(() => vi.advanceTimersByTime(9999))
  expect(screen.getByRole('alert')).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(1))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('starts a separate expiry timer for each error', () => {
  vi.useFakeTimers()
  render(<NotificationCenter />)
  act(() => notifyError('第一条'))
  act(() => vi.advanceTimersByTime(5000))
  act(() => notifyError('第二条'))
  act(() => vi.advanceTimersByTime(5000))
  expect(screen.queryByText('第一条')).not.toBeInTheDocument()
  expect(screen.getByText('第二条')).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(5000))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('refreshes a repeated message instead of stacking duplicates', () => {
  render(<NotificationCenter />)
  act(() => notifyError('无法保存'))
  act(() => notifyError('无法保存'))
  expect(screen.getAllByRole('alert')).toHaveLength(1)
})

it('shows success messages outside the content flow and expires them after ten seconds', () => {
  vi.useFakeTimers()
  render(<NotificationProvider><section data-testid="library"><OperationNotification notice={{ message: '已导入 12 项。' }}/></section></NotificationProvider>)
  expect(screen.getByTestId('library')).toBeEmptyDOMElement()
  expect(screen.getByRole('status').closest('.notification-center')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  act(() => vi.advanceTimersByTime(9999))
  expect(screen.getByRole('status')).toHaveTextContent('已导入 12 项。')
  act(() => vi.advanceTimersByTime(1))
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

it('refreshes the timer for a repeated successful operation and allows manual dismissal', () => {
  vi.useFakeTimers()
  const view = render(<NotificationProvider><OperationNotification notice={{ message: '笔记已移动。' }}/></NotificationProvider>)
  act(() => vi.advanceTimersByTime(9000))
  view.rerender(<NotificationProvider><OperationNotification notice={{ message: '笔记已移动。' }}/></NotificationProvider>)
  expect(screen.getAllByRole('status')).toHaveLength(1)
  act(() => vi.advanceTimersByTime(1000))
  expect(screen.getByRole('status')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '关闭通知' }))
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

it('expires standalone operation messages and does not announce them twice in StrictMode', () => {
  vi.useFakeTimers()
  render(<StrictMode><OperationNotification notice={{ message: '已恢复 2 项。' }}/></StrictMode>)
  expect(screen.getAllByRole('status')).toHaveLength(1)
  act(() => vi.advanceTimersByTime(10000))
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})
