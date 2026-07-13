import type React from 'react'
import { AppStateProvider } from './state/AppStateContext'
import { AppShell } from './components/shell/AppShell'

export default function App(): React.JSX.Element {
  return (
    <AppStateProvider>
      <AppShell />
    </AppStateProvider>
  )
}
