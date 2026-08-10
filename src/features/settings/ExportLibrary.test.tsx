import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExportPort, ExportReport } from '../../domain/ports'
import { ExportLibrary } from './ExportLibrary'

const emptyReport: ExportReport = {
  completed: true,
  outputRoot: 'D:\\Portable Notes\\Simple Notes Export',
  incompleteRoot: null,
  globalFailure: null,
  notesExported: 0,
  assetsExported: 0,
  renamedPaths: [],
  failed: [],
}

describe('ExportLibrary', () => {
  afterEach(cleanup)

  it('treats a cancelled directory selection as a clear no-op', async () => {
    const exporter: ExportPort = { exportLibrary: vi.fn() }
    const user = userEvent.setup()
    render(<ExportLibrary exporter={exporter} chooseDestination={vi.fn().mockResolvedValue(null)} />)

    await user.click(screen.getByRole('button', { name: 'Export complete library' }))

    expect(exporter.exportLibrary).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('Export cancelled. No files were changed.')
  })

  it('reports successful notes, assets, and deterministic path renames', async () => {
    const exporter: ExportPort = { exportLibrary: vi.fn().mockResolvedValue({
      ...emptyReport,
      notesExported: 2,
      assetsExported: 1,
      renamedPaths: [{ source: 'CON.md', destination: 'CON_.md' }],
    }) }
    const user = userEvent.setup()
    render(<ExportLibrary exporter={exporter} chooseDestination={vi.fn().mockResolvedValue('D:\\Portable Notes')} />)

    await user.click(screen.getByRole('button', { name: 'Export complete library' }))

    expect(exporter.exportLibrary).toHaveBeenCalledWith('D:\\Portable Notes')
    expect(await screen.findByRole('status')).toHaveTextContent('Exported 2 notes and 1 asset.')
    expect(screen.getByRole('status')).toHaveTextContent('Simple Notes Export')
    expect(screen.getByText('1 path was renamed for portability.')).toBeVisible()
  })

  it('reports a retained incomplete root when a global failure prevents publication', async () => {
    const exporter: ExportPort = { exportLibrary: vi.fn().mockResolvedValue({
      ...emptyReport,
      completed: false,
      outputRoot: null,
      incompleteRoot: 'D:\\Portable Notes\\.simple-notes-export-019c.partial',
      globalFailure: 'The export manifest could not be written.',
    }) }
    const user = userEvent.setup()
    render(<ExportLibrary exporter={exporter} chooseDestination={vi.fn().mockResolvedValue('D:\\Portable Notes')} />)

    await user.click(screen.getByRole('button', { name: 'Export complete library' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The export was not published.')
    expect(screen.getByRole('alert')).toHaveTextContent('.simple-notes-export-019c.partial')
    expect(screen.getByRole('alert')).toHaveTextContent('The export manifest could not be written.')
  })

  it('keeps partial failures explicit by note without hiding successful counts', async () => {
    const exporter: ExportPort = { exportLibrary: vi.fn().mockResolvedValue({
      ...emptyReport,
      notesExported: 1,
      failed: [{ noteId: '019c0000-0000-7000-8000-000000000401', message: 'The operation could not be completed on local storage.' }],
    }) }
    const user = userEvent.setup()
    render(<ExportLibrary exporter={exporter} chooseDestination={vi.fn().mockResolvedValue('D:\\Portable Notes')} />)

    await user.click(screen.getByRole('button', { name: 'Export complete library' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Exported 1 note and 0 assets with 1 failure.')
    expect(screen.getByRole('list', { name: 'Notes that could not be exported' })).toHaveTextContent('019c0000-0000-7000-8000-000000000401')
  })

  it('shows selection and command failures without issuing a second operation', async () => {
    const exporter: ExportPort = { exportLibrary: vi.fn().mockRejectedValue(new Error('private path')) }
    const user = userEvent.setup()
    render(<ExportLibrary exporter={exporter} chooseDestination={vi.fn().mockResolvedValue('D:\\Portable Notes')} />)

    await user.click(screen.getByRole('button', { name: 'Export complete library' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The library could not be exported. Existing files were left unchanged.')
    expect(exporter.exportLibrary).toHaveBeenCalledTimes(1)
  })
})
