import { useEffect, useState } from 'react';
import { api } from '../api';
import type { CollationView, EditionSummary } from '../types';
import { ErrorBox } from '../ErrorBox';

export function PublishTab({
  view,
  version,
  reload,
  onOpenEdition,
  onOpenDiff,
  onError,
  onNotice,
}: {
  view: CollationView;
  version: number;
  reload: () => Promise<void>;
  onOpenEdition: (no: number) => void;
  onOpenDiff: (no: number) => void;
  onError: (msg: string, details?: unknown) => void;
  onNotice: (msg: string) => void;
}) {
  const [editions, setEditions] = useState<EditionSummary[]>([]);
  const [busy, setBusy] = useState(false);

  const refreshEditions = () =>
    api.listEditions(view.document.id).then((r) => setEditions(r.editions)).catch(() => undefined);
  useEffect(() => {
    refreshEditions();
  }, [view.document.id, version]);

  const canPublish =
    view.stats.manuscriptCount >= 2 &&
    view.document.baseMsId != null &&
    view.stats.groupCount > 0 &&
    view.stats.brokenCount === 0;

  const publish = async () => {
    setBusy(true);
    try {
      const { editionNo } = await api.publish(view.document.id, version);
      await reload();
      await refreshEditions();
      onNotice(`校勘版 第 ${editionNo} 版 已发布；此后继续修改不影响旧版阅读。`);
    } catch (e) {
      onError((e as Error).message, (e as { details?: unknown }).details);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="card">
        <h2>发布校勘版</h2>
        <div className="muted" style={{ marginBottom: 10 }}>
          当前工作版 v{version} · 已发布至第 {view.document.publishedVer} 版。
          发布即对当前校勘结果生成不可变快照；旧发布版始终可读。
        </div>
        {view.stats.brokenCount > 0 && (
          <div className="error-box">
            仍有 {view.stats.brokenCount} 个对应组<strong>待修复</strong>。修复前不得发布新校勘版。
          </div>
        )}
        {view.stats.groupCount === 0 && (
          <div className="error-box">还没有任何对应组，不能发布。</div>
        )}
        {view.stats.manuscriptCount < 2 && (
          <div className="error-box">至少需要两份抄本才能发布。</div>
        )}
        <button className="primary" disabled={busy || !canPublish} onClick={publish}>
          {canPublish ? `发布第 ${view.document.publishedVer + 1} 版` : '暂不能发布'}
        </button>
      </div>

      <div className="card">
        <h2>已发布版本（旧版可阅读）</h2>
        {editions.length === 0 && <div className="muted">尚无已发布版本。</div>}
        {editions.map((e) => (
          <div key={e.id} className="card edition-item">
            <div>
              <strong>第 {e.edition_no} 版</strong>
              <span className="muted" style={{ marginLeft: 10 }}>
                {new Date(e.created_at).toLocaleString('zh-CN')}
              </span>
            </div>
            <div className="row-flex">
              <button onClick={() => onOpenDiff(e.edition_no)}>与当前工作版对照</button>
              <button onClick={() => onOpenEdition(e.edition_no)}>阅读此版</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
