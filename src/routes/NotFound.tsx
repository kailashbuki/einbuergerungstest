import { Link } from 'react-router-dom';
import { useT } from '@/i18n/useT';

export default function NotFound() {
  const { t } = useT();
  return (
    <div className="flex flex-col items-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold">{t('err.notFound.title')}</h1>
      <p className="text-fg-muted">{t('err.notFound.desc')}</p>
      <Link
        to="/"
        className="inline-flex min-h-touch min-w-touch items-center justify-center rounded-xl bg-accent px-5 py-3 font-medium text-accent-fg hover:opacity-90"
      >
        {t('err.notFound.home')}
      </Link>
    </div>
  );
}
