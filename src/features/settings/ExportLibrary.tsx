import { useState } from 'react'
import type { ExportPort, ExportReport } from '../../domain/ports'

interface ExportLibraryProps {
  exporter: ExportPort
  chooseDestination(): Promise<string | null>
}

export function ExportLibrary({ exporter, chooseDestination }: ExportLibraryProps) {
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<ExportReport | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const startExport = async () => {
    if (busy) return
    setBusy(true)
    setReport(null)
    setStatus(null)
    setError(null)
    try {
      const destination = await chooseDestination()
      if (destination === null) {
        setStatus('Export cancelled. No files were changed.')
        return
      }
      const next = await exporter.exportLibrary(destination)
      setReport(next)
      if (next.completed) {
        setStatus(reportSummary(next))
      } else {
        const retained = next.incompleteRoot === null
          ? 'No retained output location was available.'
          : `Incomplete files remain at ${next.incompleteRoot}.`
        setError(`The export was not published. ${retained} ${next.globalFailure ?? 'The operation did not complete.'}`)
      }
    } catch {
      setError('The library could not be exported. Existing files were left unchanged.')
    } finally {
      setBusy(false)
    }
  }

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
