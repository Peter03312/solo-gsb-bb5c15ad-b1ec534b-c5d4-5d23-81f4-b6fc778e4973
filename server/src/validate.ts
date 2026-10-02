import { FragmentDTO, GroupDTO, LineRow, ManuscriptRow } from './types';
import { charLen, isInt, rangesOverlap, HttpError } from './util';

export interface ValidationIssue {
  code: 'OUT_OF_RANGE' | 'OVERLAP' | 'NO_BASE' | 'DUP_MS' | 'BAD_LINE' | 'BAD_SHAPE' | 'DUP_ORD';
  message: string;
  groupOrd?: number;
  msName?: string;
  lineNo?: number;
  startCp?: number;
  endCp?: number;
}

interface Context {
  baseMsId: number | null;
  manuscripts: ManuscriptRow[];
  lines: LineRow[];
}

/** 校验“整批保存对应组”输入；任何问题都抛出 400 且不写库（事务回滚）。 */
export function validateGroups(input: unknown, ctx: Context): GroupDTO[] {
  const issues: ValidationIssue[] = [];
  const msById = new Map(ctx.manuscripts.map((m) => [m.id, m]));
  const lineById = new Map(ctx.lines.map((l) => [l.id, l]));

  if (!Array.isArray(input)) {
    throw new HttpError(400, 'groups 必须是数组');
  }
  if (ctx.baseMsId == null) {
    issues.push({ code: 'NO_BASE', message: '尚未选定底本，无法归组' });
  }

  // 每个真实片段统一抽成带位置的记录，供跨行全局重叠检测
  type Placed = {
    ord: number;
    msId: number;
    lineId: number;
    s: number;
    e: number;
  };
  const placed: Placed[] = [];

  const seenOrd = new Set<number>();
  const groups = input as GroupDTO[];

  groups.forEach((g, gi) => {
    const ordLabel =
      g && isInt(g.ord) ? g.ord : isInt((g as { ord?: number })?.ord) ? (g as GroupDTO).ord : gi + 1;
    if (!g || typeof g !== 'object') {
      issues.push({ code: 'BAD_SHAPE', message: `第 ${gi + 1} 组不是对象` });
      return;
    }
    if (!isInt(g.ord) || g.ord < 1) {
      issues.push({ code: 'BAD_SHAPE', message: `第 ${gi + 1} 组 ord 必须是正整数` });
    } else if (seenOrd.has(g.ord)) {
      issues.push({ code: 'DUP_ORD', message: `组序号 ${g.ord} 重复`, groupOrd: g.ord });
    } else {
      seenOrd.add(g.ord);
    }

    if (!Array.isArray(g.fragments) || g.fragments.length === 0) {
      issues.push({ code: 'NO_BASE', message: `第 ${ordLabel} 组没有任何片段`, groupOrd: ordLabel });
      return;
    }

    const seenMs = new Set<number>();
    let hasBaseReal = false;

    for (const f of g.fragments as FragmentDTO[]) {
      const msName = msById.get(f?.msId)?.name ?? `抄本#${f?.msId}`;
      if (!f || typeof f !== 'object' || !isInt(f.msId) || !msById.has(f.msId)) {
        issues.push({
          code: 'BAD_SHAPE',
          message: `第 ${ordLabel} 组引用了不存在的抄本 (msId=${f?.msId})`,
          groupOrd: ordLabel,
        });
        continue;
      }
      if (seenMs.has(f.msId)) {
        issues.push({
          code: 'DUP_MS',
          message: `第 ${ordLabel} 组中抄本「${msName}」出现多个片段（每组每抄本至多一个，缺文也占位）`,
          groupOrd: ordLabel,
          msName,
        });
        continue;
      }
      seenMs.add(f.msId);

      if (f.missing) {
        if (f.msId === ctx.baseMsId) {
          issues.push({
            code: 'NO_BASE',
            message: `第 ${ordLabel} 组的底本片段被标为缺文：每组必须含一个底本片段`,
            groupOrd: ordLabel,
            msName,
          });
        }
        continue;
      }

      // 真实片段：必须落在该抄本自己的行内且不越界
      if (!isInt(f.lineId) || !isInt(f.startCp) || !isInt(f.endCp)) {
        issues.push({
          code: 'BAD_SHAPE',
          message: `第 ${ordLabel} 组「${msName}」的片段缺少 lineId/startCp/endCp`,
          groupOrd: ordLabel,
          msName,
        });
        continue;
      }
      const ln = lineById.get(f.lineId);
      if (!ln || ln.ms_id !== f.msId) {
        issues.push({
          code: 'BAD_LINE',
          message: `第 ${ordLabel} 组「${msName}」引用的行 ${f.lineId} 不属于该抄本`,
          groupOrd: ordLabel,
          msName,
        });
        continue;
      }
      const len = charLen(ln.content);
      const overlapIssue: ValidationIssue = {
        code: 'OUT_OF_RANGE',
        message: '',
        groupOrd: ordLabel,
        msName,
        lineNo: ln.line_no,
        startCp: f.startCp,
        endCp: f.endCp,
      };
      if (f.startCp < 0 || f.endCp <= f.startCp) {
        overlapIssue.message =
          `第 ${ordLabel} 组「${msName}」片段区间非法：[${f.startCp}, ${f.endCp})（需 0 ≤ 起 < 止）`;
        issues.push(overlapIssue);
        continue;
      }
      if (f.startCp >= len || f.endCp > len) {
        overlapIssue.message =
          `第 ${ordLabel} 组「${msName}」越界：该行共 ${len} 字，` +
          `片段位于第 ${ln.line_no} 行第 ${f.startCp + 1}–${f.endCp} 字；` +
          `合法范围为第 1–${len} 字`;
        issues.push(overlapIssue);
        continue;
      }
      if (f.msId === ctx.baseMsId) hasBaseReal = true;
      placed.push({ ord: ordLabel, msId: f.msId, lineId: f.lineId, s: f.startCp, e: f.endCp });
    }

    if (ctx.baseMsId != null && !hasBaseReal) {
      issues.push({
        code: 'NO_BASE',
        message: `第 ${ordLabel} 组缺少底本片段（每组须含一个底本片段）`,
        groupOrd: ordLabel,
        msName: msById.get(ctx.baseMsId)?.name,
      });
    }
  });

  // 同一抄本片段不得重叠归组（端点相接允许）
  placed.sort((a, b) => a.msId - b.msId || a.lineId - b.lineId || a.s - b.s);
  for (let i = 1; i < placed.length; i++) {
    const a = placed[i - 1];
    const b = placed[i];
    if (a.msId === b.msId && a.lineId === b.lineId && rangesOverlap(a.s, a.e, b.s, b.e)) {
      const ln = ctx.lines.find((l) => l.id === a.lineId);
      issues.push({
        code: 'OVERLAP',
        message:
          `抄本「${msById.get(a.msId)?.name}」第 ${ln?.line_no} 行存在重叠归组：` +
          `第 ${a.ord} 组 [${a.s}, ${a.e}) 与第 ${b.ord} 组 [${b.s}, ${b.e}) ` +
          `在第 ${Math.max(a.s, b.s) + 1}–${Math.min(a.e, b.e)} 字重叠；同一抄本片段不得重叠归组`,
        groupOrd: b.ord,
        msName: msById.get(a.msId)?.name,
        lineNo: ln?.line_no,
        startCp: Math.max(a.s, b.s),
        endCp: Math.min(a.e, b.e),
      });
    }
  }

  if (issues.length > 0) {
    throw new HttpError(400, `校验失败：${issues.length} 处问题，未保存任何内容`, issues);
  }
  return groups;
}
