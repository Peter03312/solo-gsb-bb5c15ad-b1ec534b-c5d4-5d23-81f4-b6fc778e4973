import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { ErrorBox } from '../ErrorBox';
import type {
  CellChange,
  EditionDiff,
  LineDiff,
  RestoreResult,
  UnpairedCell,
  UnpairedGroupDiff,
} from '../types';

/**
 * 版本对照页：任一已发布校勘版（旧 · 不可变快照）vs 当前工作版（新 · 实时）。
 * 默认只读；查看对照后可在此页“确认恢复”——以该已发布版整体重建工作版
 * （抄本及顺序 / 底本 / 全部原始行 / 对应组片段与缺文标记；标题、已发布编号与快照不动）。
 * 页面数据与 GET /api/documents/:id/editions/:no/diff 返回的 JSON 完全一致。
 */
export function EditionDiffPage({
  docId,
  editionNo,
  onBack,
  onHome,
}: {
  docId: number;
  editionNo: number;
  onBack: () => void;
  onHome: () => void;
}) {
  const [data, setData] = useState<EditionDiff | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [errDetails, setErrDetails] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setErrDetails(null);
    setRestoreResult(null);
    try {
      setData(await api.getEditionDiff(docId, editionNo));
    } catch (e) {
      setData(null);
      setErr(String((e as Error).message ?? e));
      setErrDetails((e as ApiError).details ?? null);
    } finally {
      setLoading(false);
    }
  }, [docId, editionNo]);

  useEffect(() => {
    load();
  }, [load]);

  const restore = async () => {
    if (!data) return;
    const expectedVersion = data.sides.new.version;
    const ok = window.confirm(
      `确认将当前工作版恢复为第 ${editionNo} 版？\n\n` +
      '恢复范围：抄本及顺序、底本、全部原始行、对应组片段与缺文标记，将被整体重建为该版定稿状态；\n' +
      '文献标题、已发布版编号与全部已发布快照保持原样。\n\n' +
      `本次提交基于对照时的工作版 v${expectedVersion}；若工作版已被他人改动，将拒绝且不写入。`
    );
    if (!ok) return;
    setRestoring(true);
    setErr(null);
    setErrDetails(null);
    try {
      const r = await api.restoreEdition(docId, editionNo, expectedVersion);
      setRestoreResult(r);
      setData(null); // 对照结果已基于旧工作版；恢复后需刷新才能重新对照
    } catch (e) {
      setErr(String((e as Error).message ?? e));
      setErrDetails((e as ApiError).details ?? null);
    } finally {
      setRestoring(false);
    }
  };

  const apiUrl = `/api/documents/${docId}/editions/${editionNo}/diff`;

  return (
    <div>
      <div className="topbar">
        <span className="crumb" onClick={onHome}>首页</span>
        <span>/</span>
        <span className="crumb" onClick={onBack}>返回工作区</span>
        <span className="spacer" />
        <h1>版本对照 · 第 {editionNo} 版 ↔ 当前工作版</h1>
        <button onClick={load} disabled={loading}>{loading ? '对照中…' : '刷新（取最新工作版）'}</button>
      </div>

      <div className="container">
        {err && <ErrorBox message={err} issues={errDetails} />}
        {!data && !err && !restoreResult && <div className="muted">正在生成对照…</div>}

        {restoreResult && (
          <div className="card">
            <div className="ok-box" style={{ marginBottom: 10 }}>
              ✓ 已将工作版整体恢复为第 {restoreResult.editionNo} 版定稿；工作版版本号前进至
              <strong> v{restoreResult.version}</strong>（仅前进一次）。
              重建抄本 {restoreResult.restored.manuscriptCount} 份、原始行 {restoreResult.restored.lineCount} 行、
              对应组 {restoreResult.restored.groupCount} 组（片段 {restoreResult.restored.fragmentCount} 个，
              其中缺文 {restoreResult.restored.missingCount} 处）。行与组已取得当前有效标识；
              文献标题、已发布版编号与快照均未改动。
            </div>
            <div className="row-flex">
              <button className="primary" onClick={onBack}>返回工作区查看恢复结果</button>
              <button onClick={load}>重新生成对照（按新工作版）</button>
            </div>
          </div>
        )}

        {data && (
          <>
            <div className="card">
              <h2 style={{ marginBottom: 8 }}>{data.title}</h2>
              <div className="diff-sides">
                <div className="diff-side old">
                  <div className="side-tag">旧 · 已发布校勘版（不可变快照）</div>
                  <div>第 <strong>{data.sides.old.editionNo}</strong> 版 · 版本号 v{data.sides.old.version}</div>
                  <div className="muted">
                    底本：{data.sides.old.baseMsName ?? '—'}
                    {data.sides.old.createdAt && <> · 发布于 {new Date(data.sides.old.createdAt).toLocaleString('zh-CN')}</>}
                  </div>
                  <div className="muted">组 {data.sides.old.groupCount} · 待修复 {data.sides.old.brokenCount}</div>
                </div>
                <div className="diff-arrow">⟷</div>
                <div className="diff-side new">
                  <div className="side-tag">新 · 当前工作版（实时）</div>
                  <div>工作版 · 版本号 <strong>v{data.sides.new.version}</strong></div>
                  <div className="muted">底本：{data.sides.new.baseMsName ?? '—'}</div>
                  <div className="muted">组 {data.sides.new.groupCount} · 待修复 {data.sides.new.brokenCount}</div>
                </div>
              </div>
              <div className="muted" style={{ marginTop: 8 }}>
                对照生成于 {new Date(data.generatedAt).toLocaleString('zh-CN')}（对照只读，不修改工作版与快照；刷新反映最新工作版）。
              </div>
            </div>

            <div className="card">
              <h3>确认恢复为第 {editionNo} 版</h3>
              <div className="muted" style={{ marginBottom: 10 }}>
                查看上方对照后，可将当前工作版<strong>整体恢复</strong>为本已发布版：
                抄本及顺序、底本、全部原始行、对应组片段与缺文标记全部重建为该版定稿状态；
                文献标题、已发布版编号与全部已发布快照保持原样。重建后的行与组取得当前有效标识，
                现有编辑、对照与发布流程仍可继续使用。
                提交携带对照时的工作版版本号 <strong>v{data.sides.new.version}</strong>；
                若期间工作版已变化则拒绝且不改动数据。
              </div>
              <button className="primary" disabled={restoring || loading} onClick={restore}>
                {restoring ? '恢复中…' : `确认恢复（基于 v${data.sides.new.version}）`}
              </button>
            </div>

            <div className="card">
              <h3>HTTP API（页面与接口返回同一结果）</h3>
              <pre className="api-example">{`GET ${apiUrl}

curl ${typeof window !== 'undefined' ? window.location.origin : ''}${apiUrl}`}</pre>
            </div>

            {!data.baseSame && (
              <div className="error-box">
                两侧底本不同（旧版底本：{data.sides.old.baseMsName ?? '—'}；当前工作版底本：
                {data.sides.new.baseMsName ?? '—'}）。按规则组不配对，旧组与新组分别列出。
              </div>
            )}

            <div className="card">
              <h3>配对规则说明</h3>
              <div className="muted">{data.pairingNote}</div>
              {data.manuscripts.some((m) => !m.inOld || !m.inNew) && (
                <div style={{ marginTop: 8 }}>
                  {data.manuscripts.filter((m) => !m.inOld).map((m) => (
                    <span key={m.msId} className="pill ok">新增抄本：{m.name}</span>
                  ))}
                </div>
              )}
            </div>

            <TextChangesSection data={data} />
            <PairedGroupsSection data={data} />
            <UnpairedSection title="未配对 · 旧版组（在当前工作版无唯一对应底本位置）" groups={data.groupDiff.unpairedOld} side="old" />
            <UnpairedSection title="未配对 · 工作版组（旧版无唯一对应底本位置）" groups={data.groupDiff.unpairedNew} side="new" />
          </>
        )}
      </div>
    </div>
  );
}

// ---------- 行文增删改 ----------

function TextChangesSection({ data }: { data: EditionDiff }) {
  const { changed, added, removed } = data.textChangeCounts;
  return (
    <div className="card">
      <h3>
        行文增删改（按抄本原始行号）
        <span className="muted" style={{ marginLeft: 10, fontWeight: 'normal' }}>
          改行 {changed} · 新增行 {added} · 删除行 {removed}
        </span>
      </h3>
      <div className="legend">
        <span className="sw" style={{ background: '#d8e6d2' }} />新增
        <span className="sw" style={{ background: '#f1d4cf' }} />删除
      </div>
      {data.textChanges.length === 0 && <div className="muted">两侧行文完全一致。</div>}
      {data.textChanges.map((t) => <LineDiffRow key={`${t.msId}-${t.lineNo}-${t.status}`} t={t} />)}
    </div>
  );
}

function LineDiffRow({ t }: { t: LineDiff }) {
  return (
    <div className="line-diff-row">
      <div className="line-diff-head">
        <strong>{t.msName}</strong> 第 {t.lineNo} 行
        <span className={`pill ${t.status === 'changed' ? 'variant' : t.status === 'added' ? 'ok' : 'missing'}`}>
          {t.status === 'changed' ? '改' : t.status === 'added' ? '新增行' : '删除行'}
        </span>
      </div>
      <div className="line-diff-text">
        {t.segments.map((s, i) => (
          <span
            key={i}
            className={
              s.op === 'added' ? 'diff-add' : s.op === 'removed' ? 'diff-del' : 'diff-eq'
            }
          >
            {s.text}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------- 配对组 ----------

function PairedGroupsSection({ data }: { data: EditionDiff }) {
  const { paired } = data.groupDiff;
  const changed = paired.filter((p) => p.status === 'changed');
  return (
    <div className="card">
      <h3>
        对应组对照（按底本片段位置一一配对）
        <span className="muted" style={{ marginLeft: 10, fontWeight: 'normal' }}>
          配对 {paired.length} 组 · 其中有变化 {changed.length} 组
        </span>
      </h3>
      {paired.length === 0 && <div className="muted">没有可唯一配对的组。</div>}
      {changed.map((p) => (
        <div key={`${p.oldGroupId}-${p.newGroupId}`} className="paired-diff">
          <div className="paired-head">
            底本位置：{data.sides.new.baseMsName} 第 {p.baseLocation.lineNo} 行
            [{p.baseLocation.startCp + 1}–{p.baseLocation.endCp} 字]
            <span className="pill variant">有变化</span>
            {p.ordChanged && (
              <span className="pill invert">
                组序 {p.oldOrd} → {p.newOrd}
              </span>
            )}
            {!p.oldBroken && p.newBroken && <span className="pill broken">新待修复</span>}
            {p.oldBroken && !p.newBroken && <span className="pill ok">已修复</span>}
          </div>
          <table className="cell-diff-table">
            <thead>
              <tr><th>抄本</th><th>旧版（第 {data.sides.old.editionNo} 版）</th><th>当前工作版</th><th>变化</th></tr>
            </thead>
            <tbody>
              {p.cellChanges.map((c) => <CellChangeRow key={c.msId} c={c} />)}
            </tbody>
          </table>
        </div>
      ))}
      {paired.length > 0 && changed.length === 0 && (
        <div className="muted">所有配对组的组序、各抄本片段与缺文标记均无变化。</div>
      )}
    </div>
  );
}

function stateLabel(c: { state: 'absent' | 'missing' | 'fragment' }, broken: boolean): string {
  if (c.state === 'missing') return '缺文';
  if (c.state === 'absent') return '无片段';
  return broken ? '片段（待修复）' : '片段';
}

function CellText({ c, side }: { c: CellChange; side: 'old' | 'new' }) {
  const state = side === 'old' ? c.oldState : c.newState;
  const broken = side === 'old' ? c.oldBroken : c.newBroken;
  const oob = side === 'old' ? c.oldOutOfBounds : c.newOutOfBounds;
  const text = side === 'old' ? c.oldText : c.newText;
  const visibleText = side === 'new' ? c.newVisibleText : null;
  const oobEnd = side === 'new' ? c.newOobEnd : null;
  const lineNo = side === 'old' ? c.oldLineNo : c.newLineNo;
  const s = side === 'old' ? c.oldStartCp : c.newStartCp;
  const e = side === 'old' ? c.oldEndCp : c.newEndCp;
  if (state === 'missing') return <span className="cell-missing">〔缺文〕</span>;
  if (state === 'absent') return <span className="muted">—</span>;
  if (oob) {
    // 越界 / 失效片段：现存部分仅作参考，不作确定文字
    return (
      <span>
        <span className="cell-missing" title="片段越界或引用失效，以下现存文字仅供参考，非确定文字">
          {visibleText == null
            ? '〈片段失效，文字不确定〉'
            : `〈${visibleText}… 越界${oobEnd != null ? `，现存至第 ${oobEnd} 字` : ''}，待修复〉`}
        </span>
        <span className="pill broken">待修复</span>
      </span>
    );
  }
  return (
    <span>
      <span className="cell-text">{text}</span>
      <span className="muted" style={{ marginLeft: 6 }}>
        （第 {lineNo ?? '?'} 行{s != null && e != null ? ` [${s + 1}–${e}]` : ''}）
      </span>
      {broken && <span className="pill broken" title="该片段字面文字仍在行内、确定可读，但所属组待修复">待修复</span>}
    </span>
  );
}

function CellChangeRow({ c }: { c: CellChange }) {
  const labels: Record<string, string> = {
    state: '片段/缺文变化',
    location: '位置变化',
    text: '文字改动',
    broken: '待修复状态',
  };
  return (
    <tr className={c.newBroken || c.oldBroken ? 'broken-row' : undefined}>
      <td>
        {c.msName}
        {c.isBase && <span className="pill base">底本</span>}
      </td>
      <td><CellText c={c} side="old" /></td>
      <td><CellText c={c} side="new" /></td>
      <td>
        {c.changes.map((k) => (
          <span key={k} className={`pill ${k === 'text' ? 'variant' : k === 'broken' ? 'broken' : 'invert'}`}>
            {labels[k]}
          </span>
        ))}
        {c.textChanged && <div className="muted">确定文字已变（两侧片段均在行内）</div>}
      </td>
    </tr>
  );
}

// ---------- 未配对组 ----------

function UnpairedSection({
  title,
  groups,
  side,
}: {
  title: string;
  groups: UnpairedGroupDiff[];
  side: 'old' | 'new';
}) {
  const reasonText: Record<UnpairedGroupDiff['reason'], string> = {
    'base-differs': '两侧底本不同',
    'no-base-location': '该组无可用底本片段位置',
    'duplicate-location': '底本位置在该侧不唯一',
    'not-matched': side === 'old' ? '当前工作版同位置无组' : '旧版同位置无组',
  };
  return (
    <div className="card">
      <h3>
        {title}
        <span className="muted" style={{ marginLeft: 10, fontWeight: 'normal' }}>{groups.length} 组</span>
      </h3>
      {groups.length === 0 && <div className="muted">无。</div>}
      {groups.map((g) => (
        <div key={`${g.side}-${g.groupId}`} className={`unpaired-group ${g.broken ? 'is-broken' : ''}`}>
          <div className="unpaired-head">
            组序 {g.ord}
            <span className="pill missing">未配对</span>
            <span className="muted">原因：{reasonText[g.reason]}</span>
            {g.broken && <span className="pill broken">待修复（越界片段不作确定文字）</span>}
            {g.baseLocation && (
              <span className="muted">
                底本位置：第 {g.baseLocation.lineNo} 行 [{g.baseLocation.startCp + 1}–{g.baseLocation.endCp} 字]
              </span>
            )}
          </div>
          <div className="unpaired-cells">
            {g.cells.map((cell) => <UnpairedCellView key={cell.msId} cell={cell} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

function UnpairedCellView({ cell }: { cell: UnpairedCell }) {
  return (
    <div className="unpaired-cell">
      <span className="msname">
        {cell.msName}
        {cell.isBase && <span className="pill base">底本</span>}
      </span>
      {cell.state === 'missing' ? (
        <span className="cell-missing">〔缺文〕</span>
      ) : cell.outOfBounds ? (
        <span className="cell-missing" title="越界/失效：现存文字仅供参考，非确定文字">
          {cell.visibleText == null ? '〈片段失效，文字不确定〉' : `〈${cell.visibleText}…越界/待修复〉`}
          <span className="pill broken">待修复·越界</span>
        </span>
      ) : (
        <span>
          <span className="cell-text">{cell.text}</span>
          {cell.broken && <span className="pill broken" title="所属组待修复，但该片段仍在行内、文字确定">待修复</span>}
        </span>
      )}
      {cell.state === 'fragment' && cell.lineNo != null && (
        <span className="muted">（第 {cell.lineNo} 行）</span>
      )}
    </div>
  );
}
