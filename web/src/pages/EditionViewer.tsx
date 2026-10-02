import { useEffect, useState } from 'react';
import { api } from '../api';
import type { CollationView } from '../types';
import { CollationPage } from './CollationPage';

export function EditionViewer({
  docId,
  editionNo,
  onBack,
  onHome,
  onDiff,
}: {
  docId: number;
  editionNo: number;
  onBack: () => void;
  onHome: () => void;
  onDiff: () => void;
}) {
  const [data, setData] = useState<{ view: CollationView; createdAt: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .getEdition(docId, editionNo)
      .then((r) => setData({ view: r.view, createdAt: r.createdAt }))
      .catch((e) => setErr(String(e.message ?? e)));
  }, [docId, editionNo]);

  return (
    <div>
      <div className="topbar">
        <span className="crumb" onClick={onHome}>首页</span>
        <span>/</span>
        <span className="crumb" onClick={onBack}>返回工作区</span>
        <span className="spacer" />
        <h1>已发布 · 第 {editionNo} 版（只读）</h1>
        <button className="primary" onClick={onDiff}>与当前工作版对照</button>
      </div>
      <div className="container">
        {err && <div className="error-box">{err}</div>}
        {!data && !err && <div className="muted">载入快照中…</div>}
        {data && (
          <>
            <div className="card">
              <h2 style={{ marginBottom: 4 }}>
                {data.view.document.title}
                <span className="pill ok">第 {editionNo} 版</span>
              </h2>
              <div className="muted">
                发布时间：{new Date(data.createdAt).toLocaleString('zh-CN')} ·
                本页为发布当时的不可变快照，与当前工作版互不影响。
              </div>
            </div>
            <CollationPage view={data.view} frozen />
          </>
        )}
      </div>
    </div>
  );
}
