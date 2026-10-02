import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { CollationView } from '../types';
import { TranscribeTab } from './TranscribeTab';
import { GroupTab } from './GroupTab';
import { SupplementTab } from './SupplementTab';
import { BatchEditTab } from './BatchEditTab';
import { CollationPage } from './CollationPage';
import { PublishTab } from './PublishTab';
import { ArchiveTab } from './ArchiveTab';
import { ErrorBox } from '../ErrorBox';

type Tab = 'transcribe' | 'group' | 'supplement' | 'batchedit' | 'collation' | 'publish' | 'archive';

export function Workspace({
  docId,
  onHome,
  onOpenEdition,
  onOpenDiff,
  onOpenDocument,
}: {
  docId: number;
  onHome: () => void;
  onOpenEdition: (no: number) => void;
  onOpenDiff: (no: number) => void;
  onOpenDocument: (id: number) => void;
}) {
  const [view, setView] = useState<CollationView | null>(null);
  const [tab, setTab] = useState<Tab>('transcribe');
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const reload = useCallback(async () => {
    const v = await api.getDocument(docId);
    setView(v);
    setStale(false);
  }, [docId]);

  useEffect(() => {
    reload().catch((e) => setError(String(e.message ?? e)));
  }, [reload]);

  const raise = useCallback((msg: string, details?: unknown) => {
    setNotice(null);
    setError(msg);
    setIssues(details ?? null);
    if (msg.includes('版本已过期')) setStale(true);
  }, []);

  const flash = useCallback((msg: string) => {
    setError(null);
    setIssues(null);
    setNotice(msg);
  }, []);

  if (!view) {
    return (
      <div>
        <div className="topbar">
          <span className="crumb" onClick={onHome}>首页</span>
        </div>
        <div className="container">{error ? <div className="error-box">{error}</div> : <span className="muted">载入中…</span>}</div>
      </div>
    );
  }

  const version = view.document.version;

  return (
    <div>
      <div className="topbar">
        <span className="crumb" onClick={onHome}>首页</span>
        <span>/</span>
        <h1>{view.document.title}</h1>
        <span className="ver-badge">工作版 v{version}</span>
        <span className="ver-badge">已发布第 {view.document.publishedVer} 版</span>
        {view.stats.brokenCount > 0 && <span className="pill broken">待修复 {view.stats.brokenCount} 组</span>}
        <span className="spacer" />
        <button onClick={() => reload().catch((e: unknown) => raise((e as Error).message))}>刷新</button>
      </div>

      <div className="container">
        {stale && (
          <div className="error-box">
            ⚠ 检测到过期版本冲突：您的改动基于旧版本，已被服务端拒绝，数据未被修改。
            请点“刷新”获取最新版本后重试。
          </div>
        )}
        {error && <ErrorBox message={error} issues={issues} />}
        {notice && <div className="ok-box">✓ {notice}</div>}

        <div className="tabs">
          <button className={tab === 'transcribe' ? 'active' : ''} onClick={() => setTab('transcribe')}>
            录文与改字
          </button>
          <button className={tab === 'group' ? 'active' : ''} onClick={() => setTab('group')}>
            对应组归组
          </button>
          <button className={tab === 'supplement' ? 'active' : ''} onClick={() => setTab('supplement')}>
            补配
          </button>
          <button className={tab === 'batchedit' ? 'active' : ''} onClick={() => setTab('batchedit')}>
            批量改字
          </button>
          <button className={tab === 'collation' ? 'active' : ''} onClick={() => setTab('collation')}>
            校勘对照
          </button>
          <button className={tab === 'publish' ? 'active' : ''} onClick={() => setTab('publish')}>
            发布与旧版
          </button>
          <button className={tab === 'archive' ? 'active' : ''} onClick={() => setTab('archive')}>
            归档
          </button>
        </div>

        {tab === 'transcribe' && (
          <TranscribeTab view={view} version={version} reload={reload} onError={raise} onNotice={flash} />
        )}
        {tab === 'group' && (
          <GroupTab view={view} version={version} reload={reload} onError={raise} onNotice={flash} />
        )}
        {tab === 'supplement' && (
          <SupplementTab view={view} version={version} reload={reload} onError={raise} onNotice={flash} />
        )}
        {tab === 'batchedit' && (
          <BatchEditTab view={view} version={version} reload={reload} onError={raise} onNotice={flash} />
        )}
        {tab === 'collation' && <CollationPage view={view} />}
        {tab === 'publish' && (
          <PublishTab
            view={view}
            version={version}
            reload={reload}
            onOpenEdition={onOpenEdition}
            onOpenDiff={onOpenDiff}
            onError={raise}
            onNotice={flash}
          />
        )}
        {tab === 'archive' && (
          <ArchiveTab view={view} onError={raise} onNotice={flash} onOpenDocument={onOpenDocument} />
        )}
      </div>
    </div>
  );
}
