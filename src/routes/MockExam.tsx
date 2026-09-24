// PLACEHOLDER — replaced in the next phase. Keep trivial.
import { useT } from '@/i18n/useT';

export default function MockExam() {
  const { t } = useT();
  return (
    <div className="p-4">
      <h1 className="text-2xl font-semibold">{t('mock.title')}</h1>
      <p className="mt-2 text-fg-muted">{t('common.loading')}</p>
    </div>
  );
}
