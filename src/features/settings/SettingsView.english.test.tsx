import '@testing-library/jest-dom/vitest'
import {cleanup,render,screen} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {SettingsView} from './SettingsView'
import {DEFAULT_APP_SETTINGS} from './theme'
import type {SettingsPort} from '../../domain/ports'
vi.mock('../../shared/i18n',()=>({text:(_chinese:string,english:string)=>english}))
afterEach(cleanup)
it('renders settings navigation and common controls in English',()=>{
 const settings:SettingsPort={load:vi.fn(),update:vi.fn(),reset:vi.fn(),getStorageInfo:vi.fn().mockResolvedValue({root:'Library',noteBytes:0,assetBytes:0,trashBytes:0}),moveStorageRoot:vi.fn(),restartApplication:vi.fn(),onChanged:vi.fn().mockResolvedValue(()=>undefined),setShortcutRecording:vi.fn(),getShortcutStatus:vi.fn().mockResolvedValue({current:null,registration:{state:'active'}})}
 render(<SettingsView settings={settings} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async()=>null}/>)
 expect(screen.getByRole('tab',{name:'General'})).toBeVisible()
 expect(screen.getByRole('tab',{name:'System'})).toBeVisible()
 expect(screen.getByRole('tab',{name:'Storage'})).toBeVisible()
 expect(screen.getByRole('button',{name:'Done'})).toBeVisible()
 expect(screen.queryByRole('tab',{name:'常规'})).not.toBeInTheDocument()
})
