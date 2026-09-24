// PLACEHOLDER — replaced in the next phase. Keep trivial.
// Backs both `/level/:levelId` (a learn session) and `/drill` (no param).
import { useParams } from 'react-router-dom';
import { useT } from '@/i18n/useT';

export default function Session() {
  const { levelId } = useParams<{ levelId?: string }>();
  const { t } = useT();
  const title = levelId ? t('level.title', { name: levelId }) : t('drill.title');

  return (
    <div className="p-4">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-fg-muted">{t('common.loading')}</p>
    </div>
  );
}
