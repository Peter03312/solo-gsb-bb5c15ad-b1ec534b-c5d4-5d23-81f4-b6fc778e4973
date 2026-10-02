import React, { useMemo } from 'react';
import type { CoveredSpan } from './types';

export interface SelectionInfo {
  lineId: number;
  msId: number;
  startCp: number;
  endCp: number;
  text: string;
}

/**
 * 将一行渲染为逐字 span（data-cp 为码点序号），
 * 已归组文字以底色标示（绿=完好，黄=待修复）；
 * 用户用鼠标/手指框选即可发起归组。
 */
export function LineText({
  lineId,
  msId,
  content,
  covered,
}: {
  lineId: number;
  msId: number;
  content: string;
  covered: CoveredSpan[];
}) {
  const chars = useMemo(() => Array.from(content), [content]);
  const coverOf = useMemo(() => {
    const map = new Map<number, CoveredSpan>();
    for (const c of covered) for (let i = c.startCp; i < c.endCp; i++) map.set(i, c);
    return map;
  }, [covered]);

  return (
    <span className="line-text" data-line-id={lineId} data-ms-id={msId}>
      {chars.map((ch, i) => {
        const cov = coverOf.get(i);
        const cls = cov ? (cov.broken ? 'ch cov-broken' : 'ch cov') : 'ch';
        return (
          <span key={i} className={cls} data-cp={i}>
            {ch}
          </span>
        );
      })}
    </span>
  );
}

/** 读取当前选区；只允许同一行内的连续字句，跨行选区返回 null。 */
export function readSelection(containerRef: React.RefObject<HTMLElement>): SelectionInfo | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const anchor = (range.startContainer.nodeType === 1
    ? (range.startContainer as HTMLElement)
    : range.startContainer.parentElement)?.closest('.line-text') as HTMLElement | null;
  const focus = (range.endContainer.nodeType === 1
    ? (range.endContainer as HTMLElement)
    : range.endContainer.parentElement)?.closest('.line-text') as HTMLElement | null;
  if (!anchor || !focus || anchor !== focus) return null;
  if (!containerRef.current?.contains(anchor)) return null;

  const lineId = Number(anchor.dataset.lineId);
  const msId = Number(anchor.dataset.msId);

  // 基于选区覆盖到的 ch span 求码点区间
  const chs = Array.from(anchor.querySelectorAll('.ch')) as HTMLElement[];
  let startCp = -1;
  let endCp = -1;
  for (const ch of chs) {
    if (range.intersectsNode(ch)) {
      const cp = Number(ch.dataset.cp);
      if (startCp === -1) startCp = cp;
      endCp = cp + 1;
    }
  }
  if (startCp < 0 || endCp <= startCp) return null;
  const text = Array.from(anchor.textContent || '').slice(startCp, endCp).join('');
  return { lineId, msId, startCp, endCp, text };
}

export function clearSelection() {
  window.getSelection()?.removeAllRanges();
}
