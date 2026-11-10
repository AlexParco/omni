import React from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource/geist-mono/400.css'
import '@fontsource/geist-mono/500.css'
import '@xterm/xterm/css/xterm.css'
import './styles/tokens.css'
import './styles/base.css'
import { App } from './app/App'
import { installTestHooks } from './lib/test-hooks'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

installTestHooks()
