import { useRef, useState } from 'react';
import { api } from '../api';
import type { CollationView } from '../types';
import { LineText, readSelection, clearSelection, SelectionInfo } from '../LineText';
import { ErrorBox } from '../ErrorBox';

/**
 * 录文页签：
 *  - 各抄本按原始行序逐行录入/追加文字；
 *  - 在行内选中连续字句即可“改字”（替换/插入/删除），
 *    只有与改动相交或因此越界的对应组会变为待修复；
 *  - 已归组文字以底色标示。
 */
export function TranscribeTab({
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
  const rootRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<SelectionInfo | null>(null);
  const [replace, setReplace] = useState('');
  const [newLine, setNewLine] = useState<Record<number, string>>({});
  const [newMsName, setNewMsName] = useState('');
  const [busy, setBusy] = useState(false);

  const capture = () => {
    const s = readSelection(rootRef);
    setSel(s);
    setReplace(s ? s.text : '');
  };

  const doReplace = async () => {
    if (!sel) return;
    setBusy(true);
    try {
      await api.editLine(sel.lineId, version, sel.startCp, sel.endCp, replace);
      clearSelection();
      setSel(null);
      await reload();
      onNotice('原文已修改；受影响的对应组已标记为待修复。');
    } catch (e) {
      onError((e as Error).message, (e as { details?: unknown }).details);
    } finally {
      setBusy(false);
    }
  };

  const addLine = async (msId: number) => {
    const content = newLine[msId] ?? '';
    setBusy(true);
    try {
      await api.addLine(msId, version, content);
      setNewLine({ ...newLine, [msId]: '' });
      await reload();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const chooseBase = async (msId: number) => {
    setBusy(true);
    try {
      await api.setBase(view.document.id, version, msId);
      await reload();
      onNotice('底本已切换；不含新底本片段的组已标为待修复。');
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addMs = async () => {
    if (!newMsName.trim()) return;
    setBusy(true);
    try {
      await api.addManuscript(view.document.id, version, newMsName.trim());
      setNewMsName('');
      await reload();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rawMap = new Map(view.rawByMs.map((r) => [r.msId, r.lines]));

  return (
    <div ref={rootRef} onMouseUp={capture} onTouchEnd={capture}>
      <div className="notice-box">
        操作提示：① 在任意行中用鼠标拖选连续字句，可就地<strong>改字</strong>（替换框留空即删除）；
        ② 绿色底纹＝已归组且完好，黄色底纹＝该片段所在组<strong>待修复</strong>；
        ③ 修改原文只会使相交或因此越界的组待修复，其他组不受影响。
      </div>

      <div className="card">
        <div className="row-flex">
          <strong>底本：</strong>
          <select
            value={view.document.baseMsId ?? ''}
            disabled={busy}
            onChange={(e) => chooseBase(Number(e.target.value))}
          >
            {view.manuscripts.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <span className="muted">切换底本后，不含新底本片段的组需要修复才能发布。</span>
        </div>
        <div className="row-flex" style={{ marginTop: 10 }}>
          <input
            placeholder="新增抄本名称"
            value={newMsName}
            onChange={(e) => setNewMsName(e.target.value)}
          />
          <button disabled={busy} onClick={addMs}>＋ 增加抄本</button>
        </div>
      </div>

      <div className="ms-grid">
        {view.manuscripts.map((m) => (
          <div className="ms-panel" key={m.id}>
            <div className="ms-head">
              <span className="name">{m.name}</span>
              {m.isBase && <span className="pill base">底本</span>}
            </div>
            <div className="ms-body">
              {(rawMap.get(m.id) ?? []).map((l) => (
                <div className="line-row" key={l.lineId}>
                  <span className="line-no">{l.lineNo}.</span>
                  {l.content === '' ? (
                    <span className="muted">（空行）</span>
                  ) : (
                    <LineText
                      lineId={l.lineId}
                      msId={m.id}
                      content={l.content}
                      covered={l.covered}
                    />
                  )}
                </div>
              ))}
              {(rawMap.get(m.id) ?? []).length === 0 && (
                <div className="muted">尚未录入任何行。</div>
              )}
              <div className="add-line">
                <input
                  placeholder="新增一行（回车追加）"
                  value={newLine[m.id] ?? ''}
                  onChange={(e) => setNewLine({ ...newLine, [m.id]: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && addLine(m.id)}
                />
                <button disabled={busy} onClick={() => addLine(m.id)}>追加行</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {sel && (
        <div className="selection-bar">
          <span>
            选中：「{sel.text}」（第 {lineNoOf(view, sel.lineId)} 行，第 {sel.startCp + 1}–{sel.endCp} 字）
          </span>
          <input
            style={{ width: 220 }}
            value={replace}
            placeholder="替换为（留空=删除）"
            onChange={(e) => setReplace(e.target.value)}
          />
          <button disabled={busy} onClick={doReplace}>应用改字</button>
          <button
            onClick={() => {
              clearSelection();
              setSel(null);
            }}
          >
            取消
          </button>
        </div>
      )}
    </div>
  );
}

function lineNoOf(view: CollationView, lineId: number): number | string {
  for (const r of view.rawByMs)
    for (const l of r.lines) if (l.lineId === lineId) return l.lineNo;
  return '?';
}
