/// <reference types="vite-plugin-pwa/client" />
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { applyDocumentDir, detectUiLocale } from '@/i18n/index';
import '@/styles/index.css';

// Apply <html lang|dir> synchronously, before the first paint, so there is
// no flash of the wrong direction while React (and the async locale bundle,
// for non-English/German UI locales) loads.
applyDocumentDir(detectUiLocale());

registerSW({ immediate: true });

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element "#root" not found — check index.html.');
}

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
