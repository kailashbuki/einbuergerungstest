import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useT } from '@/i18n/useT';
import { DashboardIcon, DrillIcon, MockExamIcon, SettingsIcon, WorldsIcon } from './ui/Icons';

interface NavItem {
  readonly to: string;
  readonly labelKey: string;
  readonly icon: (props: { className?: string }) => ReactNode;
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', labelKey: 'nav.dashboard', icon: DashboardIcon },
  { to: '/worlds', labelKey: 'nav.worlds', icon: WorldsIcon },
  { to: '/drill', labelKey: 'nav.drill', icon: DrillIcon },
  { to: '/mock', labelKey: 'nav.mock', icon: MockExamIcon },
];

/**
 * App shell: header (app name + a settings gear reachable in exactly one tap
 * from every screen) + bottom nav sized for thumbs. Uses logical CSS
 * properties (ps/pe/ms/me, text-start) throughout so it mirrors correctly
 * under `dir="rtl"` without any hand-written RTL overrides.
 */
export function Layout() {
  const { t } = useT();

  return (
    <div className="flex min-h-screen flex-col bg-surface text-fg">
      <a href="#main-content" className="skip-link">
        {t('nav.skipToContent')}
      </a>

      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-line bg-surface/95 px-4 py-3 backdrop-blur">
        <span className="text-lg font-semibold text-fg">{t('app.name')}</span>
        {/* One-tap settings access from every screen, as a real link (not a button posing as one). */}
        <NavLink
          to="/settings"
          aria-label={t('nav.settings')}
          className={({ isActive }) =>
            [
              'inline-flex min-h-touch min-w-touch items-center justify-center rounded-full transition-colors hover:bg-surface-raised',
              isActive ? 'text-accent' : 'text-fg',
            ].join(' ')
          }
        >
          <SettingsIcon className="h-6 w-6" />
        </NavLink>
      </header>

      <main id="main-content" tabIndex={-1} className="flex-1 pb-[calc(4.5rem+env(safe-area-inset-bottom))]">
        <Outlet />
      </main>

      <nav
        aria-label={t('nav.menu')}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface-raised pb-safe-bottom"
      >
        <ul className="flex items-stretch justify-around">
          {NAV_ITEMS.map(({ to, labelKey, icon: Icon }) => (
            <li key={to} className="flex-1">
              <NavLink
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  [
                    'flex min-h-touch flex-col items-center justify-center gap-1 py-2 text-xs font-medium',
                    isActive ? 'text-accent' : 'text-fg-muted',
                  ].join(' ')
                }
              >
                <Icon className="h-6 w-6" />
                <span>{t(labelKey)}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
