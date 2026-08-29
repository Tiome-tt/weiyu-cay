import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExportPort, ExportReport } from '../../domain/ports'
import { ExportLibrary } from './ExportLibrary'

const emptyReport: ExportReport = {
  completed: true,
  outputRoot: 'D:\\Portable Notes\\微屿导出',
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

    await user.click(screen.getByRole('button', { name: '导出完整资料库' }))

    expect(exporter.exportLibrary).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('已取消导出，未修改任何文件。')
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

    await user.click(screen.getByRole('button', { name: '导出完整资料库' }))

    expect(exporter.exportLibrary).toHaveBeenCalledWith('D:\\Portable Notes')
    expect(await screen.findByRole('status')).toHaveTextContent('已导出 2 篇笔记和 1 个附件。')
    expect(screen.getByRole('status')).toHaveTextContent('微屿导出')
    expect(screen.getByText('为保证可移植性，已重命名 1 个路径。')).toBeVisible()
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

    await user.click(screen.getByRole('button', { name: '导出完整资料库' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('导出未发布。')
    expect(screen.getByRole('alert')).toHaveTextContent('不完整的文件可能仍保留在')
    expect(screen.getByRole('alert')).toHaveTextContent('.simple-notes-export-019c.partial')
    expect(screen.getByRole('alert')).toHaveTextContent('The export manifest could not be written.')
  })

  it('does not identify the selected path as leftovers when staging was definitely not created', async () => {
    const exporter: ExportPort = { exportLibrary: vi.fn().mockResolvedValue({
      ...emptyReport,
      completed: false,
      outputRoot: null,
      incompleteRoot: null,
      globalFailure: 'The export staging folder could not be created.',
    }) }
    const user = userEvent.setup()
    render(<ExportLibrary exporter={exporter} chooseDestination={vi.fn().mockResolvedValue('D:\\User Folder')} />)

    await user.click(screen.getByRole('button', { name: '导出完整资料库' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('没有可保留的输出位置。')
    expect(screen.getByRole('alert')).not.toHaveTextContent('D:\\User Folder')
    expect(screen.getByRole('alert')).not.toHaveTextContent('不完整的文件可能仍保留在')
  })

  it('keeps partial failures explicit by note without hiding successful counts', async () => {
    const exporter: ExportPort = { exportLibrary: vi.fn().mockResolvedValue({
      ...emptyReport,
      notesExported: 1,
      failed: [{ noteId: '019c0000-0000-7000-8000-000000000401', message: 'The operation could not be completed on local storage.' }],
    }) }
    const user = userEvent.setup()
    render(<ExportLibrary exporter={exporter} chooseDestination={vi.fn().mockResolvedValue('D:\\Portable Notes')} />)

    await user.click(screen.getByRole('button', { name: '导出完整资料库' }))

    expect(await screen.findByRole('status')).toHaveTextContent('已导出 1 篇笔记和 0 个附件，但有 1 项失败。')
    expect(screen.getByRole('list', { name: '无法导出的笔记' })).toHaveTextContent('019c0000-0000-7000-8000-000000000401')
  })

  it('shows an opaque command failure without promising that no staging files exist', async () => {
    const exporter: ExportPort = { exportLibrary: vi.fn().mockRejectedValue(new Error('private path')) }
    const user = userEvent.setup()
    render(<ExportLibrary exporter={exporter} chooseDestination={vi.fn().mockResolvedValue('D:\\Portable Notes')} />)

    await user.click(screen.getByRole('button', { name: '导出完整资料库' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '导出命令失败。重试前请检查所选父文件夹中是否存在不完整的导出文件。',
    )
    expect(screen.getByRole('alert')).not.toHaveTextContent('files were left unchanged')
    expect(exporter.exportLibrary).toHaveBeenCalledTimes(1)
  })

  it('ignores a deferred export result after its stable owner unmounts', async () => {
    const pending = deferred<ExportReport>()
    const exporter: ExportPort = { exportLibrary: vi.fn(() => pending.promise) }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const user = userEvent.setup()
    const rendered = render(
      <ExportLibrary
        exporter={exporter}
        chooseDestination={vi.fn().mockResolvedValue('D:\\Portable Notes')}
      />,
    )
    await user.click(screen.getByRole('button', { name: '导出完整资料库' }))

    rendered.unmount()
    pending.resolve(emptyReport)
    await pending.promise
    await Promise.resolve()

    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}
