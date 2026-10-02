import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { CollationView, SupplementCandidate, SupplementPreview, SupplementSelection } from '../types';

/**
 * 补配工作区：选定目标抄本后，按完好对应组的底本文字，
 * 在该抄本原始行文的“空闲区间”里预览补配候选。
 *  - 仅考虑目标抄本尚无片段且未标缺文的完好组（待修复组不参与）；
 *  - unique（唯一无冲突）默认勾选可直接采纳；multiple/conflict 由人选一处或跳过；none 只显示原因；
 *  - 提交带预览时的版本号；服务端在当前工作版整批重核，通过才写入，版本只推进一次。
 */
export function SupplementTab({
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
  const nonBase = view.manuscripts.filter((m) => !m.isBase);
  const [targetMsId, setTargetMsId] = useState<number>(nonBase[0]?.id ?? view.manuscripts[0]?.id ?? 0);
  const [preview, setPreview] = useState<SupplementPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 每组选定的候选键 `${lineId}:${startCp}:${endCp}`；null=跳过（未选）。 */
  const [picks, setPicks] = useState<Record<number, string | null>>({});

  const loadPreview = async (msId: number) => {
    if (!msId) return;
    setLoading(true);
    try {
      const p = await api.supplementPreview(view.document.id, msId);
      setPreview(p);
      // unique 候选默认勾选；其余默认跳过
      const init: Record<number, string | null> = {};
      for (const g of p.groups) {
        init[g.groupId] = g.status === 'unique' && g.candidates.length === 1 ? keyOf(g.candidates[0]) : null;
      }
      setPicks(init);
    } catch (e) {
      onError((e as Error).message, (e as { details?: unknown }).details);
      setPreview(null);
    } finally {
      setLoading(false);
    }
  };

  // 进入页签、切换目标抄本、或外部版本变化（刷新/提交后）时按当前工作版重新预览
  useEffect(() => {
    loadPreview(targetMsId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetMsId, version]);

  const targetMs = view.manuscripts.find((m) => m.id === targetMsId);
  const targetRaw = view.rawByMs.find((r) => r.msId === targetMsId);

  // 目标抄本每一行：现存覆盖区间 + 本次预览候选区间（用于行内高亮）
  const candidateSpans = useMemo(() => {
    const byLine = new Map<number, Array<{ lineId: number; startCp: number; endCp: number; kind: string }>>();
    if (!preview) return byLine;
    for (const g of preview.groups) {
      g.candidates.forEach((c) => {
        const arr = byLine.get(c.lineId) ?? [];
        arr.push({ lineId: c.lineId, startCp: c.startCp, endCp: c.endCp, kind: g.status });
        byLine.set(c.lineId, arr);
      });
    }
    return byLine;
  }, [preview]);

  const selectedCandidates = useMemo(() => {
    if (!preview) return [];
    const out: Array<{ groupId: number; cand: SupplementCandidate }> = [];
    for (const g of preview.groups) {
      const pk = picks[g.groupId];
      if (!pk) continue;
      const cand = g.candidates.find((c) => keyOf(c) === pk);
      if (cand) out.push({ groupId: g.groupId, cand });
    }
    return out;
  }, [preview, picks]);

  // 同批所选候选是否彼此重叠（前端预检；服务端仍会整批重核）
  const overlapWarn = useMemo(() => {
    const byLine = new Map<number, SupplementCandidate[]>();
    for (const { cand } of selectedCandidates) {
      const arr = byLine.get(cand.lineId) ?? [];
      arr.push(cand);
      byLine.set(cand.lineId, arr);
    }
    for (const arr of byLine.values()) {
      arr.sort((a, b) => a.startCp - b.startCp);
      for (let i = 1; i < arr.length; i++) {
        if (arr[i - 1].endCp > arr[i].startCp) return true;
      }
    }
    return false;
  }, [selectedCandidates]);

  const stalePreview = preview != null && preview.version !== version;

  const submit = async () => {
    if (!preview || selectedCandidates.length === 0) return;
    const selections: SupplementSelection[] = selectedCandidates.map(({ groupId, cand }) => ({
      groupId,
      msId: targetMsId,
      lineId: cand.lineId,
      startCp: cand.startCp,
      endCp: cand.endCp,
    }));
    setBusy(true);
    try {
      const res = await api.supplementCommit(view.document.id, preview.version, targetMsId, selections);
      await reload();
      onNotice(`已采纳 ${res.applied} 个补配候选，工作版推进至 v${res.version}；未选组与已有片段均保留。`);
    } catch (e) {
      onError((e as Error).message, (e as { details?: unknown }).details);
      // 409（版本过期 / 候选失效）后自动重新预览，供按最新工作版重选
      if ((e as { status?: number }).status === 409) {
        await loadPreview(targetMsId);
      }
    } finally {
      setBusy(false);
    }
  };

  if (view.document.baseMsId == null) {
    return <div className="card">尚未选定底本，无法补配。</div>;
  }

  return (
    <div>
      <div className="notice-box">
        补配规则：仅考虑目标抄本<strong>尚无片段且未标缺文</strong>的<strong>完好对应组</strong>（待修复组不参与）；
        候选须是该抄本<strong>单行内与底本文字完整相同</strong>的文字（位置按 Unicode 码点），且<strong>不占用任何现有片段区间</strong>。
        每组<strong>唯一且无冲突</strong>的候选才可直接采纳；无候选、多个候选或与其他组候选区间重叠时显示原因，由人选定一处或跳过。
        提交时服务端在当前工作版重新核对，整批通过才写入；版本过期返回 409，候选失效拒绝整批且不推进版本。
      </div>

      <div className="card row-flex">
        <strong>目标抄本：</strong>
        <select value={targetMsId} onChange={(e) => setTargetMsId(Number(e.target.value))}>
          {view.manuscripts.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}{m.isBase ? '（底本）' : ''}
            </option>
          ))}
        </select>
        <button onClick={() => loadPreview(targetMsId)} disabled={loading || busy}>
          {loading ? '预览中…' : '重新预览'}
        </button>
        <span className="spacer" style={{ flex: 1 }} />
        {preview && (
          <span className="muted">
            纳入 {preview.eligibleGroupCount} 组 · 未纳入 {preview.excludedGroupCount} 组 · 预览版本 v{preview.version}
            {stalePreview && <span className="pill broken">预览已过期（当前 v{version}），请重新预览</span>}
          </span>
        )}
      </div>

      {preview && preview.eligibleGroupCount === 0 && (
        <div className="card muted">
          「{preview.targetMsName}」当前没有可补配的完好组：可能所有组在该抄本已有片段或已标缺文，或仍有待修复组。
        </div>
      )}

      {preview && (
        <div className="supp-group-list">
          {preview.groups.map((g) => {
            const pick = picks[g.groupId] ?? null;
            return (
              <div key={g.groupId} className={`supp-card supp-${g.status}`}>
                <div className="row-flex">
                  <strong>第 {g.ord} 组</strong>
                  <span className="cell-text">底本「{g.baseText}」</span>
                  <StatusPill status={g.status} />
                  <span style={{ flex: 1 }} />
                  {g.status === 'unique' && (
                    <label className="muted">
                      <input
                        type="checkbox"
                        checked={pick != null}
                        onChange={(e) =>
                          setPicks((p) => ({
                            ...p,
                            [g.groupId]: e.target.checked ? keyOf(g.candidates[0]) : null,
                          }))
                        }
                      />{' '}
                      采纳
                    </label>
                  )}
                </div>
                <div className="muted" style={{ margin: '4px 0' }}>{g.reason}</div>
                {g.candidates.length > 0 && (
                  <div className="supp-cands">
                    {g.candidates.map((c) => {
                      const id = keyOf(c);
                      return (
                        <label key={id} className={`supp-cand ${pick === id ? 'picked' : ''}`}>
                          <input
                            type="radio"
                            name={`supp-${g.groupId}`}
                            checked={pick === id}
                            onChange={() => setPicks((p) => ({ ...p, [g.groupId]: id }))}
                          />
                          <span>
                            第 {c.lineNo} 行 · 第 {c.startCp + 1}–{c.endCp} 字 · 「{c.text}」
                            {c.conflictsWithGroupIds.length > 0 && (
                              <span className="pill broken">
                                与第 {c.conflictsWithGroupIds.map((id2) => ordOf(preview, id2)).join('、')} 组候选重叠
                              </span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                    {g.status !== 'unique' && (
                      <label className="supp-cand">
                        <input
                          type="radio"
                          name={`supp-${g.groupId}`}
                          checked={pick == null}
                          onChange={() => setPicks((p) => ({ ...p, [g.groupId]: null }))}
                        />
                        <span className="muted">跳过此组</span>
                      </label>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="card row-flex">
        <strong>本次采纳：{selectedCandidates.length} 组</strong>
        {overlapWarn && <span className="pill broken">所选候选区间互相重叠，提交将被拒绝</span>}
        <span style={{ flex: 1 }} />
        <button
          className="primary"
          disabled={busy || loading || !preview || selectedCandidates.length === 0 || overlapWarn || stalePreview}
          onClick={submit}
        >
          {busy ? '提交核对中…' : `提交 ${selectedCandidates.length} 个所选候选（基于预览版本 v${preview?.version ?? '-'})`}
        </button>
      </div>

      {/* 目标抄本原始行文：绿=现有片段，蓝=可补配候选区间 */}
      {targetMs && targetRaw && (
        <div className="raw-section">
          <h3>「{targetMs.name}」原始行文（候选区间就地预览）</h3>
          <div className="legend">
            <span className="sw" style={{ background: '#dcead9' }} />已有片段（占用，候选避开）
            <span className="sw" style={{ background: '#c9d8ea' }} />补配候选
          </div>
          <div className="ms-panel">
            <div className="ms-body">
              {targetRaw.lines.map((l) => (
                <div className="line-row" key={l.lineId}>
                  <span className="line-no">{l.lineNo}.</span>
                  <span className="line-text">
                    {renderLine(
                      l.content,
                      l.covered,
                      candidateSpans.get(l.lineId) ?? [],
                      new Set(selectedCandidates.filter((x) => x.cand.lineId === l.lineId).map((x) => keyOf(x.cand)))
                    )}
                  </span>
                </div>
              ))}
              {targetRaw.lines.length === 0 && <span className="muted">尚无行。</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function keyOf(c: SupplementCandidate): string {
  return `${c.lineId}:${c.startCp}:${c.endCp}`;
}

function ordOf(preview: SupplementPreview, groupId: number): number | string {
  return preview.groups.find((g) => g.groupId === groupId)?.ord ?? '?';
}

function StatusPill({ status }: { status: string }) {
  if (status === 'unique') return <span className="pill ok">唯一 · 可采纳</span>;
  if (status === 'multiple') return <span className="pill variant">多个候选</span>;
  if (status === 'conflict') return <span className="pill broken">候选冲突</span>;
  return <span className="pill missing">无候选</span>;
}

function renderLine(
  content: string,
  covered: Array<{ startCp: number; endCp: number; broken: boolean }>,
  cands: Array<{ lineId: number; startCp: number; endCp: number; kind: string }>,
  picked: Set<string>
) {
  const chars = Array.from(content);
  const cov = new Map<number, boolean>();
  for (const c of covered) for (let i = c.startCp; i < c.endCp; i++) cov.set(i, c.broken);
  // 每个码点归属的候选状态：selected（已选）优先，其次 unique/其他
  const candKind = new Map<number, string>();
  const isPicked = new Map<number, boolean>();
  for (const c of cands) {
    const selected = picked.has(`${c.lineId}:${c.startCp}:${c.endCp}`);
    for (let i = c.startCp; i < c.endCp; i++) {
      if (selected) {
        isPicked.set(i, true);
        candKind.set(i, c.kind);
      } else if (!isPicked.get(i)) {
        candKind.set(i, c.kind);
      }
    }
  }

  return chars.map((ch, i) => {
    const broken = cov.get(i);
    const kind = candKind.get(i);
    let cls = 'ch';
    if (broken === true) cls += ' cov-broken';
    else if (broken === false) cls += ' cov';
    if (kind) cls += isPicked.get(i) ? ' supp-picked' : kind === 'unique' ? ' supp-ok' : ' supp-cand';
    return <span key={i} className={cls}>{ch}</span>;
  });
}
