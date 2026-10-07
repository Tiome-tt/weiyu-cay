import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { EditorStatusBar, noteStatistics } from './EditorStatusBar'
afterEach(cleanup)
it('counts Unicode characters and lines without counting whitespace', () => {
 expect(noteStatistics('微屿 😀\n第二行')).toEqual({ lines: 2, characters: 6 })
})
it('keeps save information at the bottom and toggles a keyboard resizable related panel', () => {
 render(<EditorStatusBar text="微屿" selectedText="微" updatedAt="2026-09-28T10:00:00Z" state={{status:'saved'}} related={<p>相关内容</p>} />)
 expect(screen.getByLabelText('笔记状态栏')).toHaveTextContent('选中 1 字')
 expect(screen.queryByText('相关内容')).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button', {name:'关联笔记'}))
 expect(screen.getByText('相关内容')).toBeVisible()
 const resize=screen.getByRole('separator', {name:'调整关联笔记高度'})
 fireEvent.keyDown(resize, {key:'ArrowUp'})
 expect(resize).toHaveAttribute('aria-valuenow','144')
 fireEvent.click(screen.getByRole('button', {name:'关联笔记'}))
 expect(screen.queryByText('相关内容')).not.toBeInTheDocument()
})
