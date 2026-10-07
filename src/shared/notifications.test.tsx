import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { ErrorNotification, NotificationCenter, NotificationProvider, notifyError } from './notifications'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
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
