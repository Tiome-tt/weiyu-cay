import '../styles/tokens.css'
import '../styles/app.css'
import { LibraryLayout } from '../features/library/LibraryLayout'
import { createAppServices, type AppServices } from './services'

const defaultServices = createAppServices()

export function App({ services = defaultServices }: { services?: AppServices }) {
  return (
    <main role="application" aria-label="Simple Notes" className="app-shell">
      <LibraryLayout notes={services.notes} folders={services.folders} system={services.system} />
    </main>
  )
}
