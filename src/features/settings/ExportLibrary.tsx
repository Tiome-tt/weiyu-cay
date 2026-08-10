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
        setStatus('Export cancelled. No files were changed.')
        return
      }
      const next = await exporter.exportLibrary(destination)
      if (!mounted.current || request.current !== current) return
      setReport(next)
      if (next.completed) {
        setStatus(reportSummary(next))
      } else {
        const retained = next.incompleteRoot === null
          ? 'No retained output location was available.'
          : `Incomplete files may remain at ${next.incompleteRoot}.`
        setError(`The export was not published. ${retained} ${next.globalFailure ?? 'The operation did not complete.'}`)
      }
    } catch {
      if (mounted.current && request.current === current) {
        setError(
          'The export command failed. Check the selected parent folder for incomplete export files before retrying.',
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
      <p>Choose a parent folder. A new portable export folder will contain formal Markdown notes, their assets, and a recovery manifest.</p>
      <button type="button" disabled={busy} onClick={() => void startExport()}>
        {busy ? 'Exporting library…' : 'Export complete library'}
      </button>
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
      {report !== null && report.renamedPaths.length > 0 && (
        <p>{plural(report.renamedPaths.length, 'path was', 'paths were')} renamed for portability.</p>
      )}
      {report !== null && report.failed.length > 0 && (
        <ul aria-label="Notes that could not be exported">
          {report.failed.map((failure) => <li key={failure.noteId}><code>{failure.noteId}</code>: {failure.message}</li>)}
        </ul>
      )}
    </div>
  )
}

function reportSummary(report: ExportReport) {
  const completed = `Exported ${plural(report.notesExported, 'note', 'notes')} and ${plural(report.assetsExported, 'asset', 'assets')}`
  const counts = report.failed.length === 0
    ? `${completed}.`
    : `${completed} with ${plural(report.failed.length, 'failure', 'failures')}.`
  return report.outputRoot === null ? counts : `${counts} Output: ${report.outputRoot}.`
}

function plural(count: number, singular: string, pluralForm: string) {
  return `${count} ${count === 1 ? singular : pluralForm}`
}
