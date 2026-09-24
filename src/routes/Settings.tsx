// PLACEHOLDER — replaced in the next phase. Keep trivial.
import { useT } from '@/i18n/useT';

export default function Settings() {
  const { t } = useT();
  return (
    <div className="p-4">
      <h1 className="text-2xl font-semibold">{t('set.title')}</h1>
      <p className="mt-2 text-fg-muted">{t('common.loading')}</p>
    </div>
  );
}
