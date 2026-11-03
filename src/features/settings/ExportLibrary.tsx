import {text as uiText} from '../../shared/i18n'
import { ErrorNotification, OperationNotification } from '../../shared/notifications'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
        setStatus(uiText("已取消导出，未修改任何文件。","Export cancelled. No files were changed."))
        return
      }
      const next = await exporter.exportLibrary(destination)
      if (!mounted.current || request.current !== current) return
      setReport(next)
      if (next.completed) {
        setStatus(reportSummary(next))
      } else {
        const retained = next.incompleteRoot === null
          ? uiText("没有可保留的输出位置。","No output location was retained.")
          : uiText(`不完整的文件可能仍保留在 ${next.incompleteRoot}。`,`Incomplete files may remain in ${next.incompleteRoot}.`)
        setError(uiText(`导出未完成。${retained}请检查保存位置后重试。`,`Export did not finish. ${retained}Check the save location and try again.`))
      }
    } catch {
      if (mounted.current && request.current === current) {
        setError(
          uiText("导出失败。重试前请检查所选文件夹中是否存在不完整的导出文件。","Export failed. Check the selected folder for incomplete exported files before retrying."),
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
  const notice = useMemo(() => status ? { message: status } : null, [status, report])

  return (
    <div className="settings-export">
      <p>{uiText("导出全部正式笔记、附件和恢复清单到所选文件夹，原笔记保持完整。","Export all notes, attachments and a recovery manifest to the selected folder. Original notes are kept.")}</p>
      <button type="button" disabled={busy} onClick={() => void startExport()}>
        {busy ? uiText("正在导出资料库…","Exporting library…") : uiText("导出完整资料库","Export entire library")}
      </button>
      <OperationNotification notice={notice} />
      <ErrorNotification error={error} />
      {report !== null && report.renamedPaths.length > 0 && (
        <p>{uiText("为保证可移植性，已重命名 ","For portability, renamed ")}{report.renamedPaths.length}{uiText(" 个路径。"," paths.")}</p>
      )}
      {report !== null && report.failed.length > 0 && (
        <p>{uiText("有 ","There are ")}{report.failed.length}{uiText(" 篇笔记未能导出，请重试完整导出。"," notes that could not be exported. Retry the full export.")}</p>
      )}
    </div>
  )
}

function reportSummary(report: ExportReport) {
  const completed = uiText(`已导出 ${report.notesExported} 篇笔记和 ${report.assetsExported} 个附件`,`Exported ${report.notesExported} notes and ${report.assetsExported} attachments`)
  const counts = report.failed.length === 0
    ? `${completed}。`
    : uiText(`${completed}，但有 ${report.failed.length} 项失败。`,`${completed}, but ${report.failed.length} items failed.`)
  return report.outputRoot === null ? counts : uiText(`${counts} 输出位置：${report.outputRoot.replace(/^\\\\\?\\/u, '')}。`,`${counts} Output location: ${report.outputRoot.replace(/^\\\\\?\\/u, '')}.`)
}
