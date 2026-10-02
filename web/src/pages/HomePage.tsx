import { useEffect, useState } from 'react';
import { api } from '../api';
import type { DocumentSummary } from '../types';

export function HomePage({ onOpen }: { onOpen: (id: number) => void }) {
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [title, setTitle] = useState('');
  const [names, setNames] = useState(['底本（甲本）', '乙本']);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    api.listDocuments().then((r) => setDocs(r.documents)).catch((e) => setErr(String(e.message ?? e)));

  useEffect(() => {
    refresh();
  }, []);

  const create = async () => {
    setErr(null);
    const ms = names.map((n) => n.trim()).filter(Boolean);
    if (!title.trim()) return setErr('请填写文献标题');
    if (ms.length < 2) return setErr('至少需要两份抄本');
    setBusy(true);
    try {
      const { id } = await api.createDocument(title.trim(), ms);
      onOpen(id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="topbar">
        <h1>📜 多抄本校勘台</h1>
        <span className="spacer" />
        <span className="muted">同一文献 · 多份抄本 · 逐行对照 · 底本定序</span>
      </div>
      <div className="container">
        <div className="card">
          <h2>新建校勘文献</h2>
          <div className="row-flex">
            <label>文献标题：</label>
            <input
              style={{ width: 320 }}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="如：唐诗三百首·卷一"
            />
          </div>
          <div style={{ margin: '10px 0' }}>
            <label>抄本名称（至少两份，第一份默认为底本，稍后可改）：</label>
            <div className="ms-grid" style={{ marginTop: 8 }}>
              {names.map((n, i) => (
                <div key={i} className="row-flex">
                  <span className="muted" style={{ minWidth: 58 }}>抄本{i + 1}</span>
                  <input
                    style={{ flex: 1 }}
                    value={n}
                    onChange={(e) => {
                      const cp = [...names];
                      cp[i] = e.target.value;
                      setNames(cp);
                    }}
                  />
                  {names.length > 2 && (
                    <button className="danger" onClick={() => setNames(names.filter((_, j) => j !== i))}>
                      移除
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 8 }}>
              <button onClick={() => setNames([...names, `抄本${names.length + 1}`])}>＋ 增加抄本</button>
            </div>
          </div>
          {err && <div className="error-box">{err}</div>}
          <button className="primary" disabled={busy} onClick={create}>
            {busy ? '创建中…' : '创建并开始录入'}
          </button>
        </div>

        <div className="card">
          <h2>已有文献</h2>
          {docs === null ? (
            <span className="muted">加载中…</span>
          ) : docs.length === 0 ? (
            <span className="muted">尚无文献。</span>
          ) : (
            <div className="doc-list">
              {docs.map((d) => (
                <div key={d.id} className="card doc-item" onClick={() => onOpen(d.id)}>
                  <strong>{d.title}</strong>
                  <div className="doc-meta" style={{ marginTop: 6 }}>
                    抄本 {d.ms_count} 份 · 工作版 v{d.version} · 已发布第 {d.published_ver} 版
                    {d.broken_count > 0 && (
                      <span className="pill broken">待修复 {d.broken_count} 组</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
