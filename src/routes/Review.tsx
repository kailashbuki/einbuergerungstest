// PLACEHOLDER — replaced in the next phase. Keep trivial.
import { useParams } from 'react-router-dom';
import { useT } from '@/i18n/useT';

export default function Review() {
  const { mockId } = useParams<{ mockId: string }>();
  const { t } = useT();
  return (
    <div className="p-4">
      <h1 className="text-2xl font-semibold">{t('mock.review.title')}</h1>
      <p className="mt-2 text-fg-muted">
        {t('common.loading')} {mockId ? `(${mockId})` : ''}
      </p>
    </div>
  );
}
