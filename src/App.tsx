import { lazy, Suspense, useContext, useEffect, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import { BASE_PATH } from '@/config/paths';
import { I18nContext, I18nProvider, useT } from '@/i18n/useT';
import { detectUiLocale } from '@/i18n/index';
import { Layout } from '@/components/Layout';
import { useAppStore, useHydrated, useNeedsOnboarding, useSettings } from '@/store';
import type { ThemeSetting } from '@/types';

const Dashboard = lazy(() => import('@/routes/Dashboard'));
const WorldMap = lazy(() => import('@/routes/WorldMap'));
const Session = lazy(() => import('@/routes/Session'));
const MockExam = lazy(() => import('@/routes/MockExam'));
const Review = lazy(() => import('@/routes/Review'));
const Settings = lazy(() => import('@/routes/Settings'));
const Onboarding = lazy(() => import('@/routes/Onboarding'));
const NotFound = lazy(() => import('@/routes/NotFound'));

function RouteFallback() {
  const { t } = useT();
  return <div className="p-6 text-center text-fg-muted">{t('common.loading')}</div>;
}

function withSuspense(node: ReactNode): ReactNode {
  return <Suspense fallback={<RouteFallback />}>{node}</Suspense>;
}

/**
 * Gates the whole app behind first-run onboarding. Rendered *outside* Layout's
 * children so there is exactly one definition of "this user still needs the
 * wizard" (see `useNeedsOnboarding`) rather than a check in every screen.
 *
 * While `hydrated` is false we must render neither the app nor a redirect:
 * settings have not been read from IndexedDB yet, so a returning user would be
 * bounced into onboarding for a frame and lose their place.
 */
function OnboardingGate({ children }: { readonly children: ReactNode }): ReactNode {
  const hydrated = useHydrated();
  const needsOnboarding = useNeedsOnboarding();
  if (!hydrated) return <RouteFallback />;
  if (needsOnboarding) return <Navigate to="/onboarding" replace />;
  return children;
}

const router = createBrowserRouter(
  [
    {
      // Onboarding deliberately sits outside Layout: no bottom nav, no chrome,
      // nothing to tap away from the one thing the user has to do first.
      path: '/onboarding',
      element: withSuspense(<Onboarding />),
    },
    {
      path: '/',
      element: (
        <OnboardingGate>
          <Layout />
        </OnboardingGate>
      ),
      children: [
        { index: true, element: withSuspense(<Dashboard />) },
        { path: 'worlds', element: withSuspense(<WorldMap />) },
        { path: 'level/:levelId', element: withSuspense(<Session />) },
        { path: 'drill', element: withSuspense(<Session />) },
        { path: 'mock', element: withSuspense(<MockExam />) },
        { path: 'review/:mockId', element: withSuspense(<Review />) },
        { path: 'settings', element: withSuspense(<Settings />) },
        { path: '*', element: withSuspense(<NotFound />) },
      ],
    },
  ],
  { basename: BASE_PATH },
);

/**
 * Resolves the `theme` setting (`light|dark|system`) to a `.dark` class on
 * `<html>`. `system` tracks `prefers-color-scheme` live.
 */
function useThemeClass(theme: ThemeSetting): void {
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const apply = () => {
      const isDark = theme === 'dark' || (theme === 'system' && media.matches);
      root.classList.toggle('dark', isDark);
    };

    apply();
    if (theme === 'system') {
      media.addEventListener('change', apply);
      return () => media.removeEventListener('change', apply);
    }
    return undefined;
  }, [theme]);
}

/**
 * Pushes the persisted `uiLocale` into the i18n provider. The provider owns the
 * loaded message table (and `<html lang|dir>`); the store owns what the user
 * chose. This is the one place the two are joined, so changing the language in
 * Settings takes effect immediately with no reload and no save button.
 */
function LocaleSync(): null {
  const { uiLocale } = useSettings();
  const ctx = useContext(I18nContext);
  const setUiLocale = ctx?.setUiLocale;
  const hydrated = useHydrated();
  useEffect(() => {
    if (!hydrated || !setUiLocale) return;
    setUiLocale(uiLocale);
  }, [hydrated, uiLocale, setUiLocale]);
  return null;
}

function ThemeSync(): null {
  const { theme } = useSettings();
  useThemeClass(theme);
  return null;
}

export default function App() {
  // One hydrate() call for the whole app: it is idempotent, so a double-invoked
  // StrictMode effect is harmless.
  useEffect(() => {
    void useAppStore.getState().hydrate();
  }, []);

  return (
    // Before hydration finishes we show the browser's preferred language rather
    // than a hardcoded default, so first paint is usually already right.
    <I18nProvider initialLocale={detectUiLocale()}>
      <LocaleSync />
      <ThemeSync />
      <RouterProvider router={router} />
    </I18nProvider>
  );
}
