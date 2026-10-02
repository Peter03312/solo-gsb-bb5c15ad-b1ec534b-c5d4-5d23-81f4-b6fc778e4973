import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { CollationView, FragmentDraft, GroupDraft } from '../types';
import { LineText, readSelection, clearSelection, SelectionInfo } from '../LineText';
import { ErrorBox } from '../ErrorBox';

let keySeq = 1;
const newKey = () => `g${keySeq++}`;

interface DraftError {
  msg: string;
}

export function GroupTab({
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
  // 以服务端版本为准重建草稿（含待修复组：保留旧偏移以便定位修复）
  const [drafts, setDrafts] = useState<GroupDraft[]>(() => buildDrafts(view));
  const [syncedVer, setSyncedVer] = useState(version);
  const [sel, setSel] = useState<SelectionInfo | null>(null);
  const [targetKey, setTargetKey] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 版本变化时：以服务端组为准重建草稿，同时保留尚未保存的本地新建草稿
  useEffect(() => {
    if (syncedVer !== version) {
      setSyncedVer(version);
      setDrafts((prev) => {
        const serverDrafts = buildDrafts(view);
        const localUnsaved = prev.filter((d) => d.serverId == null);
        return [...serverDrafts, ...localUnsaved];
      });
    }
  }, [version, view, syncedVer]);

  const brokenIds = useMemo(
    () => new Set(view.groups.filter((g) => g.broken).map((g) => g.id)),
    [view]
  );
  // 所有草稿组均可作为“并入”目标（待修复组正需重新选取字句）
  const targetDrafts = drafts;
  const rawMap = new Map(view.rawByMs.map((r) => [r.msId, r.lines]));

  const capture = () => {
    const s = readSelection(rootRef);
    setSel(s);
    setTargetKey('');
  };

  const mutFrag = (key: string, msId: number, patch: Partial<FragmentDraft>) => {
    setDrafts((ds) =>
      ds.map((g) => {
        if (g.key !== key) return g;
        const exists = g.fragments.find((f) => f.msId === msId);
        const fragments = exists
          ? g.fragments.map((f) => (f.msId === msId ? { ...f, ...patch } : f))
          : [...g.fragments, { msId, missing: false, ...patch }];
        return { ...g, fragments };
      })
    );
  };

  const removeFrag = (key: string, msId: number) =>
    setDrafts((ds) =>
      ds.map((g) => (g.key === key ? { ...g, fragments: g.fragments.filter((f) => f.msId !== msId) } : g))
    );

  const createGroupFromSel = () => {
    if (!sel) return;
    const d: GroupDraft = {
      key: newKey(),
      ord: drafts.filter((x) => !x.serverBroken).length + 1,
      fragments: [{ msId: sel.msId, missing: false, lineId: sel.lineId, startCp: sel.startCp, endCp: sel.endCp }],
    };
    setDrafts([...drafts, d]);
    setSel(null);
    clearSelection();
  };

  const addToGroup = () => {
    if (!sel || !targetKey) return;
    mutFrag(targetKey, sel.msId, {
      missing: false,
      lineId: sel.lineId,
      startCp: sel.startCp,
      endCp: sel.endCp,
    });
    setSel(null);
    clearSelection();
    setTargetKey('');
  };

  const removeGroup = async (key: string) => {
    const g = drafts.find((d) => d.key === key);
    if (!g) return;
    setBusy(true);
    try {
      if (g.serverId != null && !g.serverBroken) {
        await api.deleteGroup(view.document.id, g.serverId, version);
        await reload();
        onNotice('已删除对应组。');
      } else {
        setDrafts(drafts.filter((d) => d.key !== key));
      }
    } catch (e) {
      onError((e as Error).message, (e as { details?: unknown }).details);
    } finally {
      setBusy(false);
    }
  };

  const saveAll = async () => {
    const errs = clientValidate(drafts, view);
    if (errs.length > 0) {
      onError(`本地预检发现 ${errs.length} 处问题，未发送保存请求：\n` + errs.map((e) => '· ' + e.msg).join('\n'));
      return;
    }
    const groups = drafts
      .filter((d) => !d.serverBroken)
      .map((g, i) => ({
        ord: i + 1,
        fragments: g.fragments.map((f) => ({
          msId: f.msId,
          missing: f.missing,
          lineId: f.missing ? null : f.lineId,
          startCp: f.missing ? null : f.startCp,
          endCp: f.missing ? null : f.endCp,
        })),
      }));
    setBusy(true);
    try {
      await api.saveGroups(view.document.id, version, groups);
      await reload();
      onNotice('对应组已全部保存（服务端已重新校验）。');
    } catch (e) {
      onError((e as Error).message, (e as { details?: unknown }).details);
    } finally {
      setBusy(false);
    }
  };

  const repairOne = async (g: GroupDraft) => {
    if (g.serverId == null) return;
    const errs = clientValidate([g], view, g.serverId);
    if (errs.length > 0) {
      onError(errs.map((e) => '· ' + e.msg).join('\n'));
      return;
    }
    setBusy(true);
    try {
      await api.repairGroup(view.document.id, g.serverId, version, {
        ord: g.ord,
        fragments: g.fragments.map((f) => ({
          msId: f.msId,
          missing: f.missing,
          lineId: f.missing ? null : f.lineId,
          startCp: f.missing ? null : f.startCp,
          endCp: f.missing ? null : f.endCp,
        })),
      });
      await reload();
      onNotice(`第 ${g.ord} 组已修复。`);
    } catch (e) {
      onError((e as Error).message, (e as { details?: unknown }).details);
    } finally {
      setBusy(false);
    }
  };

  const fragText = (f: FragmentDraft | undefined): string | null => {
    if (!f) return null;
    if (f.missing) return null;
    if (f.lineId == null || f.startCp == null || f.endCp == null) return '?';
    // 取该行当前内容（码点安全截取）
    const r = view.rawByMs.find((x) => x.msId === f.msId);
    const ln = r?.lines.find((l) => l.lineId === f.lineId);
    if (!ln) return '（行已不存在）';
    const len = Array.from(ln.content).length;
    if ((f.startCp ?? 0) < 0 || (f.endCp ?? 0) <= (f.startCp ?? 0) || (f.startCp ?? 0) >= len) return '【越界】';
    return Array.from(ln.content)
      .slice(f.startCp ?? 0, Math.min(f.endCp ?? len, len))
      .join('');
  };

  return (
    <div ref={rootRef} onMouseUp={capture} onTouchEnd={capture}>
      <div className="notice-box">
        归组规则：每组<strong>必须含一个底本片段</strong>；其他抄本每组至多占一个片段，或显式标为<strong>缺文</strong>；
        同一抄本的片段<strong>不得跨行内重叠区间</strong>归组。保存时若有越界 / 重叠 / 缺底本，将逐条指出位置且<strong>不会部分保存</strong>。
        在任意抄本行文中拖选字句后，使用下方浮动条新建组或并入已有组。
      </div>

      <div className="card row-flex">
        <strong>本地草稿：</strong>
        <span className="muted">
          新建/编辑中组 {drafts.filter((d) => !d.serverBroken).length} 个
          {brokenIds.size > 0 && <>，待修复 {brokenIds.size} 组</>}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="primary" disabled={busy || brokenIds.size > 0 || drafts.some((d) => d.serverBroken)} onClick={saveAll}>
          {brokenIds.size > 0 ? '有待修复组，暂不能整批保存' : '保存全部对应组'}
        </button>
        <span className="muted">（待修复组请逐组修复；其余改动随修复后的整批保存生效）</span>
      </div>

      {/* 待修复组（优先列出） */}
      {drafts.filter((d) => d.serverBroken).map((g) => (
        <DraftCard
          key={g.key}
          g={g}
          view={view}
          broken
          busy={busy}
          fragText={fragText}
          mutFrag={mutFrag}
          removeFrag={removeFrag}
          onRepair={() => repairOne(g)}
          onRemove={() => removeGroup(g.key)}
        />
      ))}

      {/* 正常草稿组（含已保存完好组） */}
      {drafts.filter((d) => !d.serverBroken).map((g) => (
        <DraftCard
          key={g.key}
          g={g}
          view={view}
          busy={busy}
          fragText={fragText}
          mutFrag={mutFrag}
          removeFrag={removeFrag}
          onRemove={() => removeGroup(g.key)}
        />
      ))}

      {drafts.length === 0 && (
        <div className="card muted">尚无对应组。请到行文中选中字句开始归组。</div>
      )}

      {/* 各抄本原文（供拖选，原始行序；底色为已覆盖区间） */}
      <div className="raw-section">
        <h3>抄本原文（原始行序，拖选字句以归组）</h3>
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
                      <LineText lineId={l.lineId} msId={m.id} content={l.content} covered={l.covered} />
                    )}
                  </div>
                ))}
                {(rawMap.get(m.id) ?? []).length === 0 && <div className="muted">尚无行。</div>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {sel && (
        <div className="selection-bar">
          <span>
            选中「{sel.text}」· {msName(view, sel.msId)} · 第 {lineNoOf(view, sel.lineId)} 行 · 字 {sel.startCp + 1}–{sel.endCp}
          </span>
          <button disabled={busy} onClick={createGroupFromSel}>＋ 新建对应组</button>
          <select value={targetKey} onChange={(e) => setTargetKey(e.target.value)}>
            <option value="">并入已有组…</option>
            {targetDrafts.map((d) => (
              <option key={d.key} value={d.key}>
                第 {d.ord} 组{d.serverBroken ? '（待修复）' : ''}
              </option>
            ))}
          </select>
          <button disabled={busy || !targetKey} onClick={addToGroup}>并入</button>
          <button
            onClick={() => {
              setSel(null);
              clearSelection();
            }}
          >
            取消
          </button>
        </div>
      )}
    </div>
  );
}

function DraftCard({
  g,
  view,
  broken,
  busy,
  fragText,
  mutFrag,
  removeFrag,
  onRepair,
  onRemove,
}: {
  g: GroupDraft;
  view: CollationView;
  broken?: boolean;
  busy: boolean;
  fragText: (f: FragmentDraft | undefined) => string | null;
  mutFrag: (key: string, msId: number, patch: Partial<FragmentDraft>) => void;
  removeFrag: (key: string, msId: number) => void;
  onRepair?: () => void;
  onRemove: () => void;
}) {
  return (
    <div className={`draft-card ${broken ? 'broken' : ''}`}>
      <div className="row-flex">
        <strong>第 {g.ord} 组</strong>
        {broken && <span className="pill broken">待修复</span>}
        {g.serverId != null && !broken && <span className="pill ok">已保存</span>}
        <span style={{ flex: 1 }} />
        {broken && onRepair && (
          <button className="primary" disabled={busy} onClick={onRepair}>修复此组</button>
        )}
        <button className="danger" disabled={busy} onClick={onRemove}>{broken ? '放弃修复草稿' : '删除组'}</button>
      </div>
      {view.manuscripts.map((m) => {
        const f = g.fragments.find((x) => x.msId === m.id);
        const txt = fragText(f);
        return (
          <div className="draft-frag" key={m.id}>
            <span className="msname">
              {m.name}
              {m.isBase && <span className="pill base">底本</span>}
            </span>
            {f?.missing ? (
              <>
                <span className="cell-missing">〔缺文〕</span>
                {!m.isBase && (
                  <button onClick={() => mutFrag(g.key, m.id, { missing: false })}>改为片段</button>
                )}
              </>
            ) : f ? (
              <>
                <span className="cell-text">「{txt}」</span>
                {txt === '【越界】' && <span className="pill broken">越界·待修复</span>}
                <button onClick={() => removeFrag(g.key, m.id)}>清除</button>
                {!m.isBase && (
                  <button onClick={() => mutFrag(g.key, m.id, { missing: true, lineId: null, startCp: null, endCp: null })}>
                    标为缺文
                  </button>
                )}
              </>
            ) : (
              <span className="muted">
                未参与
                {!m.isBase && (
                  <>
                    {' '}· <button onClick={() => mutFrag(g.key, m.id, { missing: true })}>标为缺文</button>
                  </>
                )}
              </span>
            )}
          </div>
        );
      })}
      {broken && (
        <div className="muted" style={{ marginTop: 6 }}>
          请在下方行文中重新选取该组各抄本的字句（至少底本），再点“修复此组”。
        </div>
      )}
    </div>
  );
}

// ---------- 草稿初始化与本地预检 ----------

function buildDrafts(view: CollationView): GroupDraft[] {
  const lineOf = new Map<number, { msId: number; lineNo: number }>();
  view.rawByMs.forEach((r) => r.lines.forEach((l) => lineOf.set(l.lineId, { msId: r.msId, lineNo: l.lineNo })));
  const out: GroupDraft[] = [];
  for (const g of view.groups) {
    const fragments: FragmentDraft[] = [];
    for (const c of g.cells) {
      if (c.missing) {
        fragments.push({ msId: c.msId, missing: true });
      } else if (c.startCp != null && c.endCp != null) {
        fragments.push({ msId: c.msId, missing: false, lineId: findLineId(view, c.msId, c.lineNo), startCp: c.startCp, endCp: c.endCp });
      }
    }
    out.push({ key: `srv${g.id}`, ord: g.ord, serverId: g.id, serverBroken: g.broken, fragments });
  }
  return out.sort((a, b) => Number(a.serverBroken) - Number(b.serverBroken) || a.ord - b.ord);
}

function findLineId(view: CollationView, msId: number, lineNo?: number): number | null {
  if (lineNo == null) return null;
  const r = view.rawByMs.find((x) => x.msId === msId);
  return r?.lines.find((l) => l.lineNo === lineNo)?.lineId ?? null;
}

function msName(view: CollationView, msId: number): string {
  return view.manuscripts.find((m) => m.id === msId)?.name ?? `#${msId}`;
}
function lineNoOf(view: CollationView, lineId: number): number | string {
  for (const r of view.rawByMs) for (const l of r.lines) if (l.lineId === lineId) return l.lineNo;
  return '?';
}

function clientValidate(
  groups: GroupDraft[],
  view: CollationView,
  onlyGroupId?: number
): DraftError[] {
  const errs: DraftError[] = [];
  const baseId = view.document.baseMsId;
  const lineLen = new Map<number, { msId: number; len: number; lineNo: number }>();
  view.rawByMs.forEach((r) =>
    r.lines.forEach((l) => lineLen.set(l.lineId, { msId: r.msId, len: Array.from(l.content).length, lineNo: l.lineNo }))
  );

  const placed: Array<{ ord: number; msId: number; lineId: number; s: number; e: number }> = [];

  groups.forEach((g) => {
    if (baseId == null) errs.push({ msg: `第 ${g.ord} 组：尚未选定底本` });
    const seen = new Set<number>();
    let hasBase = false;
    for (const f of g.fragments) {
      if (seen.has(f.msId)) errs.push({ msg: `第 ${g.ord} 组：抄本「${msName(view, f.msId)}」重复出现` });
      seen.add(f.msId);
      if (f.missing) continue;
      const ln = f.lineId != null ? lineLen.get(f.lineId) : undefined;
      if (!ln || ln.msId !== f.msId) {
        errs.push({ msg: `第 ${g.ord} 组：抄本「${msName(view, f.msId)}」缺少有效行引用` });
        continue;
      }
      if (f.startCp == null || f.endCp == null || f.startCp < 0 || f.endCp <= f.startCp) {
        errs.push({ msg: `第 ${g.ord} 组「${msName(view, f.msId)}」片段区间非法` });
        continue;
      }
      if (f.startCp >= ln.len || f.endCp > ln.len) {
        errs.push({
          msg:
            `第 ${g.ord} 组「${msName(view, f.msId)}」越界：第 ${ln.lineNo} 行共 ${ln.len} 字，` +
            `片段在第 ${f.startCp + 1}–${f.endCp} 字`,
        });
        continue;
      }
      if (f.msId === baseId) hasBase = true;
      placed.push({ ord: g.ord, msId: f.msId, lineId: f.lineId as number, s: f.startCp, e: f.endCp });
    }
    if (baseId != null && !hasBase) errs.push({ msg: `第 ${g.ord} 组缺少底本片段` });
  });

  // 单组修复时，只与该组自身片段查重（服务端还会与其他组重叠检测）
  placed.sort((a, b) => a.msId - b.msId || a.lineId - b.lineId || a.s - b.s);
  for (let i = 1; i < placed.length; i++) {
    const a = placed[i - 1];
    const b = placed[i];
    if (a.msId === b.msId && a.lineId === b.lineId && a.s < b.e && b.s < a.e) {
      if (onlyGroupId != null && a.ord !== b.ord) continue;
      const ln = lineLen.get(a.lineId);
      errs.push({
        msg:
          `抄本「${msName(view, a.msId)}」第 ${ln?.lineNo} 行重叠归组：` +
          `第 ${a.ord} 组 [${a.s + 1}, ${a.e}] 与第 ${b.ord} 组 [${b.s + 1}, ${b.e}]`,
      });
    }
  }
  return errs;
}
