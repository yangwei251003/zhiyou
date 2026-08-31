import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { DemoStoreProvider } from './store/DemoStore'
import { RealCareerStoreProvider } from './store/RealCareerStore'
import { ToastProvider } from './components/ui/Toast'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Renderer root element is missing')

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <DemoStoreProvider>
      <RealCareerStoreProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </RealCareerStoreProvider>
    </DemoStoreProvider>
  </React.StrictMode>,
)
