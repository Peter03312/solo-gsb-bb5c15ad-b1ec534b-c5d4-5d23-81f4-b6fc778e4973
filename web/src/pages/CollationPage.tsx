import type { CollationView } from '../types';

/**
 * 对照页（读模型）：
 *  上：依底本顺序的对应组总表（异文 / 缺文 / 倒置 / 待修复）；
 *  下：各抄本原始行序，已归组部分加底色——未归组文字自然完整可见。
 * 同时用于已发布旧版（只读快照）。
 */
export function CollationPage({ view, frozen }: { view: CollationView; frozen?: boolean }) {
  return (
    <div>
      <div className="legend">
        标记说明：
        <span className="pill variant">异文</span>
        <span className="pill missing">缺文</span>
        <span className="pill invert">倒置</span>
        <span className="pill broken">待修复</span>
        {frozen && <span className="pill ok">已发布快照（只读）</span>}
      </div>

      <table className="group-table">
        <thead>
          <tr>
            <th style={{ width: 60 }}>组序</th>
            {view.manuscripts.map((m) => (
              <th key={m.id}>
                {m.name}
                {m.isBase && <span className="pill base">底本</span>}
              </th>
            ))}
            <th style={{ width: 110 }}>判定</th>
          </tr>
        </thead>
        <tbody>
          {view.groups.map((g) => (
            <tr key={g.id} className={g.broken ? 'broken-row' : undefined}>
              <td>
                <strong>{g.ord}</strong>
                {g.broken && <span className="pill broken">待修复</span>}
              </td>
              {g.cells.map((c) => {
                const ms = view.manuscripts.find((m) => m.id === c.msId)!;
                if (c.missing) {
                  return (
                    <td key={c.msId}>
                      <span className="cell-missing">〔缺文〕</span>
                    </td>
                  );
                }
                const isBase = ms.isBase;
                const diff =
                  !isBase && !c.broken && c.text !== undefined && c.text !== g.baseText;
                return (
                  <td key={c.msId}>
                    <span className="cell-text">{c.text ?? '—'}</span>
                    {diff && <span className="pill variant">异文</span>}
                    {c.broken && (
                      <span className="cell-broken-note">
                        {c.oobEnd != null
                          ? `原文缩短，片段越界（现存至第 ${c.oobEnd} 字），待修复`
                          : '片段越界或引用失效，待修复'}
                      </span>
                    )}
                    {!isBase && c.lineNo != null && !c.broken && (
                      <span className="muted">（{ms.name}第 {c.lineNo} 行）</span>
                    )}
                  </td>
                );
              })}
              <td>
                {g.variant && !g.broken && <span className="pill variant">异文</span>}
                {g.hasMissing && <span className="pill missing">缺文</span>}
                {g.inverted && !g.broken && <span className="pill invert">倒置</span>}
                {!g.variant && !g.hasMissing && !g.inverted && !g.broken && (
                  <span className="muted">同</span>
                )}
              </td>
            </tr>
          ))}
          {view.groups.length === 0 && (
            <tr>
              <td colSpan={view.manuscripts.length + 2} className="muted">
                尚无对应组。
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="raw-section">
        <h3>各抄本原文（原始行序；底色为已归组文字，其余为未归组文字）</h3>
        <div className="legend">
          <span className="sw" style={{ background: '#dcead9' }} />已归组（完好）
          <span className="sw" style={{ background: '#f3ddbb' }} />所属组待修复
        </div>
        <div className="ms-grid">
          {view.rawByMs.map((rb) => {
            const ms = view.manuscripts.find((m) => m.id === rb.msId)!;
            return (
              <div className="ms-panel" key={rb.msId}>
                <div className="ms-head">
                  <span className="name">{ms.name}</span>
                  {ms.isBase && <span className="pill base">底本</span>}
                </div>
                <div className="ms-body">
                  {rb.lines.map((l) => (
                    <div className="line-row" key={l.lineId}>
                      <span className="line-no">{l.lineNo}.</span>
                      <span className="line-text">
                        {renderCovered(l.content, l.covered)}
                      </span>
                    </div>
                  ))}
                  {rb.lines.length === 0 && <span className="muted">尚无行。</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function renderCovered(
  content: string,
  covered: Array<{ startCp: number; endCp: number; groupId: number; broken: boolean }>
) {
  const chars = Array.from(content);
  const map = new Map<number, boolean>();
  for (const c of covered) for (let i = c.startCp; i < c.endCp; i++) map.set(i, c.broken);
  return chars.map((ch, i) => {
    const broken = map.get(i);
    if (broken === undefined) return <span key={i} className="ch">{ch}</span>;
    return (
      <span key={i} className={broken ? 'ch cov-broken' : 'ch cov'}>
        {ch}
      </span>
    );
  });
}
