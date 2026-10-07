import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { FormatMenu } from './FormatMenu'
afterEach(cleanup)
it('offers themed choices without moving pointer focus and supports keyboard selection', () => {
 const change=vi.fn()
 render(<FormatMenu label="字体" value="" options={[{value:'',label:'默认字体'},{value:'serif',label:'衬线'}]} onChange={change}/>)
 const trigger=screen.getByRole('button',{name:'字体'})
 fireEvent.click(trigger)
 expect(screen.getByRole('menuitemradio',{name:'默认字体'})).not.toHaveFocus()
 fireEvent.keyDown(document.body,{key:'Escape'})
 expect(screen.queryByRole('menu')).not.toBeInTheDocument()
 fireEvent.keyDown(trigger,{key:'ArrowDown'})
 expect(screen.getByRole('menuitemradio',{name:'默认字体'})).toHaveFocus()
 fireEvent.keyDown(screen.getByRole('menuitemradio',{name:'默认字体'}),{key:'ArrowDown'})
 const next=screen.getByRole('menuitemradio',{name:'衬线'})
 expect(next).toHaveFocus()
 fireEvent.click(next)
 expect(change).toHaveBeenCalledWith('serif')
 expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})
