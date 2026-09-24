// PLACEHOLDER — replaced in the next phase. Keep trivial.
//
// Note: ui.en.json has no dedicated `onboarding.*` title key, so this stub
// reuses `app.name` for its heading rather than hardcoding English text.
import { useT } from '@/i18n/useT';

export default function Onboarding() {
  const { t } = useT();
  return (
    <div className="p-4">
      <h1 className="text-2xl font-semibold">{t('app.name')}</h1>
      <p className="mt-2 text-fg-muted">{t('common.loading')}</p>
    </div>
  );
}
