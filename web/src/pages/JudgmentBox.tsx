import { useState } from 'react';
import { api } from '../api';
import type {
  CollationView,
  GroupView,
  JudgmentView,
  OrphanJudgmentView,
} from '../types';

/**
 * 判读意见区块（校勘对照页内）。
 * - 工作版：可写入（已裁定 = 选一份有有效片段的抄本 + 理由；或明确标为未裁定）、
 *   重新确认、撤回；每次写入携带当前工作版版本号。
 * - 已发布快照（frozen）：只读展示发布当时固化的意见与引用文字。
 */
export function JudgmentCell({
  docId,
  view,
  group,
  version,
  frozen,
  reload,
  onError,
  onNotice,
}: {
  docId: number;
  view: CollationView;
  group: GroupView;
  version?: number;
  frozen?: boolean;
  reload: () => Promise<void>;
  onError: (msg: string, details?: unknown) => void;
  onNotice: (msg: string) => void;
}) {
  const j = group.judgment;
  if (frozen) return <FrozenJudgment j={j} />;
  return (
    <JudgmentEditor
      docId={docId}
      view={view}
      group={group}
      judgment={j}
      version={version ?? 0}
      reload={reload}
      onError={onError}
      onNotice={onNotice}
    />
  );
}

function FrozenJudgment({ j }: { j: JudgmentView | null }) {
  if (!j) return <span className="muted">—</span>;
  if (j.status === 'undecided') {
    return (
      <span className="judgment-undecided">
        <span className="pill missing">未裁定</span>
        {j.reason && <span className="judgment-reason">{j.reason}</span>}
      </span>
    );
  }
  if (j.status === 'review') {
    return (
      <span className="judgment-review">
        <span className="pill broken">待复核（发布时固化）</span>
      </span>
    );
  }
  return (
    <span className="judgment-confirmed">
      <span className="pill ok">已裁定</span>
      <span className="judgment-quote">「{j.quoteText}」</span>
      <span className="muted">（{j.chosenMsName ?? '?'}）</span>
      {j.reason && <span className="judgment-reason">{j.reason}</span>}
    </span>
  );
}

function JudgmentEditor({
  docId,
  view,
  group,
  judgment,
  version,
  reload,
  onError,
  onNotice,
}: {
  docId: number;
  view: CollationView;
  group: GroupView;
  judgment: JudgmentView | null;
  version: number;
  reload: () => Promise<void>;
  onError: (msg: string, details?: unknown) => void;
  onNotice: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [decided, setDecided] = useState<boolean>(judgment?.decided ?? true);
  const [chosenMsId, setChosenMsId] = useState<number | ''>(
    judgment?.chosenMsId ?? view.manuscripts.find((m) => !m.isBase)?.id ?? ''
  );
  const [reason, setReason] = useState<string>(judgment?.reason ?? '');

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      await reload();
      setEditing(false);
      onNotice(ok);
    } catch (e) {
      onError((e as Error).message, (e as { details?: unknown }).details);
    } finally {
      setBusy(false);
    }
  };

  if (group.broken) {
    return (
      <span className="muted">
        组待修复，修复后才能下判读意见
        {judgment?.needsReview && (
          <span className="judgment-review">
            <span className="pill broken">原意见待复核</span>
          </span>
        )}
      </span>
    );
  }

  if (judgment?.needsReview) {
    return (
      <span className="judgment-review">
        <span className="pill broken">待复核</span>
        <span className="judgment-reason">{judgment.reviewReason}</span>
        <span className="judgment-quote">
          {judgment.quoteText && <>引用：「{judgment.quoteText}」（{judgment.chosenMsName ?? '?'}）</>}
        </span>
        <span className="row-flex">
          <button
            disabled={busy}
            onClick={() =>
              run(
                () => api.reconfirmJudgment(docId, judgment.id, version, group.id),
                '判读意见已重新确认'
              )
            }
          >
            引用仍有效，重新确认
          </button>
          <button
            className="danger"
            disabled={busy}
            onClick={() =>
              run(() => api.withdrawJudgment(docId, judgment.id, version), '判读意见已撤回')
            }
          >
            撤回
          </button>
        </span>
      </span>
    );
  }

  if (!editing) {
    return (
      <span className={judgment?.status === 'undecided' ? 'judgment-undecided' : judgment?.status === 'confirmed' ? 'judgment-confirmed' : ''}>
        {judgment?.status === 'confirmed' && (
          <>
            <span className="pill ok">已裁定</span>
            <span className="judgment-quote">「{judgment.quoteText}」</span>
            <span className="muted">（{judgment.chosenMsName ?? '?'}）</span>
          </>
        )}
        {judgment?.status === 'undecided' && <span className="pill missing">未裁定</span>}
        {!judgment && <span className="muted">无意见</span>}
        {judgment?.reason && <span className="judgment-reason">{judgment.reason}</span>}
        <button onClick={() => { setEditing(true); setDecided(judgment?.decided ?? true); setChosenMsId(judgment?.chosenMsId ?? view.manuscripts.find((m) => !m.isBase)?.id ?? ''); setReason(judgment?.reason ?? ''); }}>
          {judgment ? '修改意见' : '下判读意见'}
        </button>
        {judgment && (
          <button
            className="danger"
            disabled={busy}
            onClick={() =>
              run(() => api.withdrawJudgment(docId, judgment.id, version), '判读意见已撤回')
            }
          >
            撤回
          </button>
        )}
      </span>
    );
  }

  // 有真实（非缺文、在行内）片段的抄本才可被选为依据
  const selectable = view.manuscripts
    .map((m) => {
      const cell = group.cells.find((c) => c.msId === m.id);
      const valid = !!cell && !cell.missing && !cell.broken && cell.text !== undefined;
      return { m, cell, valid };
    });

  const submit = () =>
    run(
      () =>
        api.putJudgment(docId, group.id, version, {
          decided,
          chosenMsId: decided ? Number(chosenMsId) : null,
          reason: decided ? reason : reason,
        }),
      decided ? '判读意见（已裁定）已保存' : '已标记为未裁定'
    );

  return (
    <span className="judgment-edit">
      <label className="row-flex">
        <input type="radio" checked={decided} onChange={() => setDecided(true)} />
        已裁定：选一份有有效片段的抄本
      </label>
      {decided && (
        <>
          <select
            value={chosenMsId}
            onChange={(e) => setChosenMsId(e.target.value === '' ? '' : Number(e.target.value))}
          >
            {selectable.map(({ m, valid }) => (
              <option key={m.id} value={m.id} disabled={!valid}>
                {m.name}
                {m.isBase ? '（底本）' : ''}
                {!valid ? '（无有效片段，不可选）' : ''}
              </option>
            ))}
          </select>
        </>
      )}
      <label className="row-flex">
        <input type="radio" checked={!decided} onChange={() => setDecided(false)} />
        明确标为未裁定（可发布）
      </label>
      <textarea
        rows={2}
        style={{ width: '100%' }}
        placeholder={decided ? '理由（必填）' : '理由（选填）'}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <span className="row-flex">
        <button className="primary" disabled={busy} onClick={submit}>
          保存意见
        </button>
        <button disabled={busy} onClick={() => setEditing(false)}>
          取消
        </button>
      </span>
    </span>
  );
}

/** 失去组归属的待复核意见列表（孤儿；不静默移到别组，须重新确认或撤回）。 */
export function OrphanJudgments({
  docId,
  view,
  version,
  frozen,
  reload,
  onError,
  onNotice,
}: {
  docId: number;
  view: CollationView;
  version?: number;
  frozen?: boolean;
  reload: () => Promise<void>;
  onError: (msg: string, details?: unknown) => void;
  onNotice: (msg: string) => void;
}) {
  const orphans = view.orphanJudgments ?? [];
  if (orphans.length === 0) return null;
  return (
    <div className="card judgment-orphans">
      <h3>待复核判读意见（{orphans.length} 条，原对应组已消失 / 无法唯一对应）</h3>
      <div className="muted" style={{ marginBottom: 8 }}>
        这些意见不会被静默移到其他组；须逐条重新确认到当前某组，或撤回后才能发布。未裁定意见也须重新确认或撤回。
      </div>
      {orphans.map((j) => (
        <OrphanRow
          key={j.id}
          docId={docId}
          view={view}
          j={j}
          version={version ?? 0}
          frozen={frozen}
          reload={reload}
          onError={onError}
          onNotice={onNotice}
        />
      ))}
    </div>
  );
}

function OrphanRow({
  docId,
  view,
  j,
  version,
  frozen,
  reload,
  onError,
  onNotice,
}: {
  docId: number;
  view: CollationView;
  j: OrphanJudgmentView;
  version: number;
  frozen?: boolean;
  reload: () => Promise<void>;
  onError: (msg: string, details?: unknown) => void;
  onNotice: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<number | ''>('');
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      await reload();
      onNotice(ok);
    } catch (e) {
      onError((e as Error).message, (e as { details?: unknown }).details);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="judgment-orphan-row">
      <div>
        {j.decided ? <span className="pill ok">已裁定</span> : <span className="pill missing">未裁定</span>}
        <span className="pill broken">待复核</span>
        {j.lastOrd != null && <span className="muted">原第 {j.lastOrd} 组</span>}
        {j.decided && (
          <span className="judgment-quote">
            引用「{j.quoteText}」（{j.chosenMsName ?? '?'}
            {j.chosenLineNo != null ? `·第 ${j.chosenLineNo} 行` : ''}）
          </span>
        )}
        {j.reason && <span className="judgment-reason">{j.reason}</span>}
        <div className="muted">{j.reviewReason}</div>
      </div>
      {!frozen && (
        <div className="row-flex">
          <select value={target} onChange={(e) => setTarget(e.target.value === '' ? '' : Number(e.target.value))}>
            <option value="">重新确认到当前组…</option>
            {view.groups
              .filter((g) => !g.broken)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  第 {g.ord} 组（{g.baseText}）
                </option>
              ))}
          </select>
          <button
            disabled={busy || target === ''}
            onClick={() =>
              run(
                () => api.reconfirmJudgment(docId, j.id, version, target === '' ? null : Number(target)),
                '判读意见已重新确认并挂到所选组'
              )
            }
          >
            重新确认
          </button>
          <button
            className="danger"
            disabled={busy}
            onClick={() => run(() => api.withdrawJudgment(docId, j.id, version), '判读意见已撤回')}
          >
            撤回
          </button>
        </div>
      )}
    </div>
  );
}
