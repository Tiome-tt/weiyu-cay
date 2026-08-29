import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExportPort, ExportReport } from '../../domain/ports'

interface ExportLibraryProps {
  exporter?: ExportPort
  chooseDestination?(): Promise<string | null>
  controller?: ExportLibraryController
}
export interface ExportLibraryController {
  busy: boolean
  report: ExportReport | null
  status: string | null
  error: string | null
  startExport(): Promise<void>
}

export function useExportLibraryController(
  exporter?: ExportPort,
  chooseDestination?: () => Promise<string | null>,
): ExportLibraryController {
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<ExportReport | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const request = useRef(0)
  const busyRef = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      request.current += 1
    }
  }, [])

  useEffect(() => {
    request.current += 1
    busyRef.current = false
    setBusy(false)
  }, [chooseDestination, exporter])

  const startExport = useCallback(async () => {
    if (busyRef.current || exporter === undefined || chooseDestination === undefined) return
    busyRef.current = true
    const current = ++request.current
    setBusy(true)
    setReport(null)
    setStatus(null)
    setError(null)
    try {
      const destination = await chooseDestination()
      if (!mounted.current || request.current !== current) return
      if (destination === null) {
        setStatus('已取消导出，未修改任何文件。')
        return
      }
      const next = await exporter.exportLibrary(destination)
      if (!mounted.current || request.current !== current) return
      setReport(next)
      if (next.completed) {
        setStatus(reportSummary(next))
      } else {
        const retained = next.incompleteRoot === null
          ? '没有可保留的输出位置。'
          : `不完整的文件可能仍保留在 ${next.incompleteRoot}。`
        setError(`导出未发布。${retained}${next.globalFailure ?? '操作未完成。'}`)
      }
    } catch {
      if (mounted.current && request.current === current) {
        setError(
          '导出命令失败。重试前请检查所选父文件夹中是否存在不完整的导出文件。',
        )
      }
    } finally {
      busyRef.current = false
      if (mounted.current && request.current === current) setBusy(false)
    }
  }, [chooseDestination, exporter])

  return { busy, report, status, error, startExport }
}

export function ExportLibrary({ exporter, chooseDestination, controller }: ExportLibraryProps) {
  const localController = useExportLibraryController(exporter, chooseDestination)
  const { busy, report, status, error, startExport } = controller ?? localController

  return (
    <div className="settings-export">
      <p>选择一个父文件夹。新的便携式导出文件夹将包含正式 Markdown 笔记、附件和恢复清单。</p>
      <button type="button" disabled={busy} onClick={() => void startExport()}>
        {busy ? '正在导出资料库…' : '导出完整资料库'}
      </button>
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
      {report !== null && report.renamedPaths.length > 0 && (
        <p>为保证可移植性，已重命名 {report.renamedPaths.length} 个路径。</p>
      )}
      {report !== null && report.failed.length > 0 && (
        <ul aria-label="无法导出的笔记">
          {report.failed.map((failure) => <li key={failure.noteId}><code>{failure.noteId}</code>: {failure.message}</li>)}
        </ul>
      )}
    </div>
  )
}

function reportSummary(report: ExportReport) {
  const completed = `已导出 ${report.notesExported} 篇笔记和 ${report.assetsExported} 个附件`
  const counts = report.failed.length === 0
    ? `${completed}。`
    : `${completed}，但有 ${report.failed.length} 项失败。`
  return report.outputRoot === null ? counts : `${counts} 输出位置：${report.outputRoot}。`
}
