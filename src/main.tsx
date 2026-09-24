/// <reference types="vite-plugin-pwa/client" />
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { applyDocumentDir, detectUiLocale } from '@/i18n/index';
import { isNative } from '@/config/paths';
import '@/styles/index.css';

// Apply <html lang|dir> synchronously, before the first paint, so there is
// no flash of the wrong direction while React (and the async locale bundle,
// for non-English/German UI locales) loads.
applyDocumentDir(detectUiLocale());

// Web only. A Capacitor shell already has every asset on the device inside the
// app bundle, so there is nothing for a service worker to cache — and on iOS
// there is no worker to register at all, because WKWebView does not run service
// workers for pages served from the `capacitor://` scheme. Registering anyway
// would throw on iOS and do nothing useful on Android.
//
// Consequence worth knowing: the app-update path differs by target. The web gets
// the new build on the next visit via the worker; a store build only updates when
// the user installs a new version.
if (!isNative) registerSW({ immediate: true });

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
