import { useState } from 'react';
import { api } from '../api';
import type { BatchEditPreview, CollationView } from '../types';

/**
 * 批量行改页签：一次校订同一文献多份抄本的多份原始行。
 *  - 编辑列表以 JSON 录入（每项 lineId/startCp/endCp/replacement，区间按改前原文字符数计、左闭右开）；
 *  - 先预览各行新文字、片段新位置与受影响组，确认后携带文献版本号整批写入；
 *  - 区间重叠 / 同点重复插入 / 插入点落在他编辑区间内或端点 / 跨文献行 / 非法区间整批拒绝。
 */
export function BatchEditTab({
  view,
  version,
  reload,
  onError,
  onNotice,
}: {
  view: CollationView;
  version: number;
  reload: () => Promise<void>;
  onError: (msg: string, details?: unknown) => void;
  onNotice: (msg: string) => void;
}) {
  const [text, setText] = useState(
    '[\n  { "lineId": 0, "startCp": 0, "endCp": 1, "replacement": "字" }\n]'
  );
  const [preview, setPreview] = useState<BatchEditPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const parseEdits = (): Array<{ lineId: number; startCp: number; endCp: number; replacement: string }> | null => {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      onError(`JSON 解析失败：${(e as Error).message}`);
      return null;
    }
    if (!Array.isArray(data) || data.length === 0) {
      onError('编辑列表须为非空数组。');
      return null;
    }
    return data as Array<{ lineId: number; startCp: number; endCp: number; replacement: string }>;
  };

  const doPreview = async () => {
    const edits = parseEdits();
    if (!edits) return;
    setBusy(true);
    try {
      const p = await api.batchEditPreview(view.document.id, edits);
      setPreview(p);
      onNotice(`预览完成：${p.editCount} 项编辑、${p.lines.length} 行、受影响组 ${p.brokenGroups.length} 个。`);
    } catch (e) {
      setPreview(null);
      onError((e as Error).message, (e as { details?: unknown }).details);
    } finally {
      setBusy(false);
    }
  };

  const doCommit = async () => {
    if (!preview) return;
    const edits = parseEdits();
    if (!edits) return;
    setBusy(true);
    try {
      const r = await api.batchEditCommit(view.document.id, version, edits, preview.basis);
      setPreview(null);
      await reload();
      onNotice(`批量行改已写入，文献版本推进至 v${r.version}。`);
    } catch (e) {
      onError((e as Error).message, (e as { details?: unknown }).details);
    } finally {
      setBusy(false);
    }
  };

  const msName = (msId: number) => view.manuscripts.find((m) => m.id === msId)?.name ?? `#${msId}`;

  return (
    <div>
      <div className="notice-box">
        输入<strong>非空编辑列表</strong>（JSON），每项 <code>lineId / startCp / endCp / replacement</code>；
        区间按<strong>改前原文</strong>的 Unicode 码点计（左闭右开），<code>startCp=endCp</code> 为插入、
        <code>replacement:""</code> 为删除。先预览，再确认整批写入；同一行编辑区间重叠、同点重复插入、
        插入点落在他编辑区间内或端点都会整批拒绝。
      </div>

      <div className="card">
        <textarea
          style={{ width: '100%', minHeight: 120, fontFamily: 'monospace' }}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="row-flex" style={{ marginTop: 8 }}>
          <button disabled={busy} onClick={doPreview}>预览</button>
          <button
            disabled={busy || !preview}
            onClick={doCommit}
            title={preview ? `按当前工作版 v${version} 提交` : '请先预览'}
          >
            确认整批写入（v{version}）
          </button>
          {preview && (
            <span className="muted">
              预览基于 v{preview.version}；写入前服务端会重新核对版本与行状态（basis）。
            </span>
          )}
        </div>
      </div>

      {preview && (
        <>
          <h3>各行新文字（{preview.lines.length} 行）</h3>
          <div className="card">
            {preview.lines.map((l) => (
              <div key={l.lineId} style={{ marginBottom: 10 }}>
                <div>
                  <span className="pill base">{l.msName}</span> 第 {l.lineNo} 行（lineId={l.lineId}）
                  <span className="muted"> {l.oldLengthCp} → {l.newLengthCp} 字；命中 {l.edits.length} 项编辑</span>
                </div>
                <div style={{ marginTop: 4 }}>
                  <span className="muted">改前：</span>{l.oldContent || '（空）'}
                </div>
                <div>
                  <span className="muted">改后：</span><strong>{l.newContent || '（空）'}</strong>
                </div>
              </div>
            ))}
          </div>

          <h3>片段新位置（{preview.fragments.length} 个）</h3>
          <div className="card">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th align="left">组序</th><th align="left">抄本</th><th align="left">行</th>
                  <th align="left">原区间</th><th align="left">新区间</th><th align="left">状态</th><th align="left">说明</th>
                </tr>
              </thead>
              <tbody>
                {preview.fragments.map((f) => (
                  <tr key={f.fragmentId} style={{ borderTop: '1px solid #eee' }}>
                    <td>{f.groupOrd}{f.groupAlreadyBroken && <span className="pill broken">原已待修复</span>}</td>
                    <td>{msName(f.msId)}</td>
                    <td>{f.lineNo}</td>
                    <td>[{f.oldStartCp}, {f.oldEndCp})</td>
                    <td>[{f.newStartCp}, {f.newEndCp})</td>
                    <td>
                      <span className={`pill ${f.status === 'broken' ? 'broken' : f.status === 'moved' ? 'base' : ''}`}>
                        {f.status === 'broken' ? '待修复' : f.status === 'moved' ? '平移' : '不变'}
                      </span>
                    </td>
                    <td className="muted">{f.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>受影响组（{preview.brokenGroups.length} 个）</h3>
          <div className="card">
            {preview.brokenGroups.length === 0 && <div className="muted">无待修复组。</div>}
            {preview.brokenGroups.map((g) => (
              <div key={g.groupId}>
                <span className={`pill ${g.newlyBroken ? 'broken' : 'base'}`}>
                  第 {g.ord} 组{g.newlyBroken ? '·新标待修复' : '·原已待修复'}
                </span>{' '}
                <span className="muted">{g.reason}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
