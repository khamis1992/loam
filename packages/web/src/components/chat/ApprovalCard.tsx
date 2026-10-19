// TODO(a7): A7 owns the full ApprovalCard implementation per BUILD_SPEC §6.7.
import { t } from '@/i18n/t';
import { Button } from '@/components/ui/Button';
import { desktopApis } from '@/services/desktopApis';
import type { FolderAccessRequestEvent } from '@shared/socket';

export function ApprovalCard({ request }: { request: FolderAccessRequestEvent }) {
  const answer = (decision: 'deny' | 'once' | 'always') =>
    desktopApis.desktopOperator.respondFolderAccess({ requestId: request.requestId, decision });
  return (
    <div role="group" aria-label={t('Folder access request')} className="rounded-card bg-bg-menu p-4 shadow-card">
      <div className="text-title-base">🔒 {t('Folder access request')}</div>
      <code className="mt-1 block break-all text-xs text-text-secondary">{request.path}</code>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={() => answer('deny')}>{t('Deny')}</Button>
        <Button onClick={() => answer('once')}>{t('Allow once')}</Button>
        <Button variant="primary" onClick={() => answer('always')}>{t('Always allow in {product}')}</Button>
      </div>
    </div>
  );
}
