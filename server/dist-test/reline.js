"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkBasis = checkBasis;
exports.buildReLinePlan = buildReLinePlan;
exports.applyReLinePlan = applyReLinePlan;
const util_1 = require("./util");
/** 解析行 id / 码点参数：JSON 数字或纯整数字符串均可，其余一律拒绝。 */
function toInt(v) {
    if (typeof v === 'number' && Number.isInteger(v))
        return v;
    if (typeof v === 'string' && /^-?\d+$/.test(v.trim()))
        return Number(v.trim());
    return null;
}
/** 取行并确认属于本文献；行不存在 → 404，不属于本文献 → 400。 */
async function loadLineInDoc(client, docId, lineId, forUpdate) {
    const { rows } = await client.query(`SELECT id, ms_id, line_no, content FROM lines WHERE id=$1${forUpdate ? ' FOR UPDATE' : ''}`, [lineId]);
    if (rows.length === 0)
        throw new util_1.HttpError(404, `行 #${lineId} 不存在`);
    const line = rows[0];
    const { rows: msr } = await client.query('SELECT id, doc_id, name, position FROM manuscripts WHERE id=$1', [line.ms_id]);
    const ms = msr[0];
    if (!ms || ms.doc_id !== docId) {
        throw new util_1.HttpError(400, `行 #${lineId} 不属于本文献的抄本，已拒绝`, {
            code: 'LINE_NOT_IN_DOC',
            lineId,
        });
    }
    return { line, ms };
}
async function loadMsLines(client, msId, forUpdate) {
    const { rows } = await client.query(`SELECT id, ms_id, line_no, content FROM lines WHERE ms_id=$1 ORDER BY line_no${forUpdate ? ' FOR UPDATE' : ''}`, [msId]);
    return rows;
}
/** 取若干行上的真实片段（缺文标记不依附行，不在此列、永不变动）及其所属组。 */
async function loadLineFrags(client, docId, lineIds) {
    if (lineIds.length === 0)
        return [];
    const { rows: frags } = await client.query(`SELECT id, group_id, doc_id, ms_id, line_id, start_cp, end_cp, missing
     FROM fragments
     WHERE doc_id=$1 AND line_id = ANY($2::bigint[]) AND missing=FALSE
     ORDER BY line_id, start_cp, id`, [docId, lineIds]);
    if (frags.length === 0)
        return [];
    const gids = [...new Set(frags.map((f) => f.group_id))];
    const { rows: grps } = await client.query('SELECT id, doc_id, ord, broken FROM grp WHERE id = ANY($1::bigint[])', [gids]);
    const grpById = new Map(grps.map((g) => [g.id, g]));
    return frags.map((frag) => ({ frag, grp: grpById.get(frag.group_id) }));
}
async function loadSplitCtx(client, docId, lineId, forUpdate) {
    const { line, ms } = await loadLineInDoc(client, docId, lineId, forUpdate);
    const msLines = await loadMsLines(client, ms.id, forUpdate);
    const frags = await loadLineFrags(client, docId, [lineId]);
    return { ms, msLines, line, frags };
}
async function loadMergeCtx(client, docId, leftLineId, rightLineId, forUpdate) {
    if (leftLineId === rightLineId) {
        throw new util_1.HttpError(400, '同一行不能与自身合并', { code: 'SAME_LINE', lineId: leftLineId });
    }
    const l = await loadLineInDoc(client, docId, leftLineId, forUpdate);
    const r = await loadLineInDoc(client, docId, rightLineId, forUpdate);
    if (l.ms.id !== r.ms.id) {
        throw new util_1.HttpError(400, `行 #${leftLineId} 与行 #${rightLineId} 不属于同一抄本，不能合并`, {
            code: 'DIFFERENT_MS',
            leftLineId,
            rightLineId,
        });
    }
    if (r.line.line_no !== l.line.line_no + 1) {
        throw new util_1.HttpError(400, `第 ${l.line.line_no} 行与第 ${r.line.line_no} 行不相邻，不能合并（仅可合并同一抄本内相邻的两行）`, { code: 'NOT_ADJACENT', leftLineNo: l.line.line_no, rightLineNo: r.line.line_no });
    }
    const msLines = await loadMsLines(client, l.ms.id, forUpdate);
    const frags = await loadLineFrags(client, docId, [leftLineId, rightLineId]);
    return {
        ms: l.ms,
        msLines,
        left: l.line,
        right: r.line,
        leftFrags: frags.filter((x) => x.frag.line_id === leftLineId),
        rightFrags: frags.filter((x) => x.frag.line_id === rightLineId),
    };
}
function splitBasis(ctx) {
    return {
        lineId: ctx.line.id,
        lineNo: ctx.line.line_no,
        content: ctx.line.content,
        lengthCp: (0, util_1.charLen)(ctx.line.content),
    };
}
function mergeBasis(ctx) {
    return {
        leftLineId: ctx.left.id,
        leftLineNo: ctx.left.line_no,
        leftContent: ctx.left.content,
        leftLengthCp: (0, util_1.charLen)(ctx.left.content),
        rightLineId: ctx.right.id,
        rightLineNo: ctx.right.line_no,
        rightContent: ctx.right.content,
        rightLengthCp: (0, util_1.charLen)(ctx.right.content),
    };
}
/**
 * 提交时核对预览所依据的行：缺 basis → 400；任一字段与当前不符 → 409 整次拒绝。
 * （版本一致时行必然未变；此核对为显式兜底，并防止客户端把 basis 张冠李戴。）
 */
function checkBasis(actual, given) {
    if (!given || typeof given !== 'object' || Array.isArray(given)) {
        throw new util_1.HttpError(400, '缺少 basis：请原样带回预览响应中的 basis，以确认预览所依据的行未变化');
    }
    const g = given;
    const mismatched = [];
    for (const [k, v] of Object.entries(actual)) {
        if (JSON.stringify(g[k]) !== JSON.stringify(v))
            mismatched.push(k);
    }
    if (mismatched.length > 0) {
        throw new util_1.HttpError(409, '预览所依据的行已变化，已整次拒绝、未写入任何内容，请重新预览后再确认', {
            code: 'RELINE_STALE',
            mismatchedFields: mismatched,
        });
    }
}
function computeSplitPlan(ctx, splitCp) {
    const { line, ms, msLines, frags } = ctx;
    const len = (0, util_1.charLen)(line.content);
    if (splitCp < 1 || splitCp > len - 1) {
        throw new util_1.HttpError(400, len < 2
            ? `拆分点非法：第 ${line.line_no} 行仅 ${len} 字，无法在行内拆分（拆分后两段都须非空）`
            : `拆分点非法：第 ${line.line_no} 行共 ${len} 字，拆分点须为 1–${len - 1}（行内，按 Unicode 码点计），收到 ${splitCp}`, { code: 'BAD_SPLIT_POINT', lineNo: line.line_no, lineLength: len, splitCp });
    }
    const n = line.line_no;
    const leftContent = (0, util_1.sliceCp)(line.content, 0, splitCp);
    const rightContent = (0, util_1.sliceCp)(line.content, splitCp, len);
    const lines = [];
    for (const l of msLines) {
        if (l.line_no < n) {
            lines.push({ lineId: l.id, lineNo: l.line_no, oldLineNo: l.line_no, content: l.content, origin: 'kept' });
        }
        else if (l.id === line.id) {
            lines.push({ lineId: l.id, lineNo: n, oldLineNo: n, content: leftContent, origin: 'split-left' });
            lines.push({ lineId: null, lineNo: n + 1, oldLineNo: n, content: rightContent, origin: 'split-right' });
        }
        else {
            lines.push({ lineId: l.id, lineNo: l.line_no + 1, oldLineNo: l.line_no, content: l.content, origin: 'shifted' });
        }
    }
    const fragments = [];
    const brokenGroups = [];
    const seenBroken = new Set();
    const pushBroken = (grp, newly, reason) => {
        if (seenBroken.has(grp.id))
            return;
        seenBroken.add(grp.id);
        brokenGroups.push({ groupId: grp.id, ord: grp.ord, newlyBroken: newly, reason });
    };
    for (const { frag, grp } of frags) {
        const s = frag.start_cp;
        const e = frag.end_cp;
        const base = {
            fragmentId: frag.id,
            groupId: grp.id,
            groupOrd: grp.ord,
            groupAlreadyBroken: grp.broken,
            oldLineId: line.id,
            oldLineNo: n,
            oldStartCp: s,
            oldEndCp: e,
        };
        if (e <= splitCp) {
            fragments.push({
                ...base,
                status: 'unchanged',
                newLineId: line.id,
                newLineNo: n,
                newStartCp: s,
                newEndCp: e,
                note: '片段整体位于拆分点之前，随左段保留在原行，区间不变',
            });
        }
        else if (s >= splitCp) {
            fragments.push({
                ...base,
                status: 'moved',
                newLineId: null, // 新行提交后才有 id
                newLineNo: n + 1,
                newStartCp: s - splitCp,
                newEndCp: e - splitCp,
                note: `片段整体位于拆分点之后，随右段迁至新行（第 ${n + 1} 行），区间平移 ${splitCp} 个码点`,
            });
        }
        else {
            fragments.push({
                ...base,
                status: 'broken',
                newLineId: line.id,
                newLineNo: n,
                newStartCp: s,
                newEndCp: e,
                note: '片段跨越拆分点：保留原行原区间（右端越界）以便追溯，所在组标为待修复；不得把另一行文字当作其确定文字',
            });
        }
        if (grp.broken) {
            pushBroken(grp, false, '组原已待修复，行界调整后保持待修复（不自动转为完好）');
        }
        else if (s < splitCp && splitCp < e) {
            pushBroken(grp, true, `第 ${grp.ord} 组片段 [${s}, ${e}) 跨越拆分点 ${splitCp}，标为待修复`);
        }
    }
    return {
        op: 'split',
        msId: ms.id,
        msName: ms.name,
        splitCp,
        basis: splitBasis(ctx),
        lines,
        fragments,
        brokenGroups,
    };
}
function computeMergePlan(ctx) {
    const { ms, msLines, left, right, leftFrags, rightFrags } = ctx;
    const leftLen = (0, util_1.charLen)(left.content);
    const mergedContent = left.content + right.content;
    const n = left.line_no;
    const lines = [];
    for (const l of msLines) {
        if (l.line_no < n) {
            lines.push({ lineId: l.id, lineNo: l.line_no, oldLineNo: l.line_no, content: l.content, origin: 'kept' });
        }
        else if (l.id === left.id) {
            lines.push({ lineId: l.id, lineNo: n, oldLineNo: n, content: mergedContent, origin: 'merged' });
        }
        else if (l.id === right.id) {
            continue; // 右行并入左行后删除
        }
        else {
            lines.push({ lineId: l.id, lineNo: l.line_no - 1, oldLineNo: l.line_no, content: l.content, origin: 'shifted' });
        }
    }
    const fragments = [];
    const brokenGroups = [];
    const seenBroken = new Set();
    const pushBroken = (grp, reason) => {
        if (seenBroken.has(grp.id))
            return;
        seenBroken.add(grp.id);
        brokenGroups.push({ groupId: grp.id, ord: grp.ord, newlyBroken: false, reason });
    };
    for (const { frag, grp } of leftFrags) {
        fragments.push({
            fragmentId: frag.id,
            groupId: grp.id,
            groupOrd: grp.ord,
            groupAlreadyBroken: grp.broken,
            oldLineId: left.id,
            oldLineNo: n,
            oldStartCp: frag.start_cp,
            oldEndCp: frag.end_cp,
            status: 'unchanged',
            newLineId: left.id,
            newLineNo: n,
            newStartCp: frag.start_cp,
            newEndCp: frag.end_cp,
            note: '左行片段保留在合并行原区间，位置不变',
        });
        if (grp.broken)
            pushBroken(grp, '组原已待修复，合并后保持待修复（不自动转为完好）');
    }
    for (const { frag, grp } of rightFrags) {
        const s = frag.start_cp;
        const e = frag.end_cp;
        fragments.push({
            fragmentId: frag.id,
            groupId: grp.id,
            groupOrd: grp.ord,
            groupAlreadyBroken: grp.broken,
            oldLineId: right.id,
            oldLineNo: right.line_no,
            oldStartCp: s,
            oldEndCp: e,
            status: 'moved',
            newLineId: left.id,
            newLineNo: n,
            newStartCp: s + leftLen,
            newEndCp: e + leftLen,
            note: `右行片段迁至左行（合并行），区间平移 ${leftLen} 个码点`,
        });
        if (grp.broken)
            pushBroken(grp, '组原已待修复，合并后保持待修复（不自动转为完好）');
    }
    return {
        op: 'merge',
        msId: ms.id,
        msName: ms.name,
        basis: mergeBasis(ctx),
        lines,
        fragments,
        brokenGroups,
    };
}
/**
 * 预览 / 提交共用：解析参数、装载并校验当前行状态、（提交时）核对 basis、计算计划。
 * 非法码点位置、非相邻行、不属于本文献的行在此明确拒绝（400/404）。
 */
async function buildReLinePlan(client, doc, raw, opts) {
    const op = raw.op;
    if (op !== 'split' && op !== 'merge') {
        throw new util_1.HttpError(400, 'op 必须是 split（行内拆分）或 merge（合并相邻两行）');
    }
    if (op === 'split') {
        const lineId = toInt(raw.lineId);
        const splitCp = toInt(raw.splitCp);
        if (lineId == null || lineId <= 0)
            throw new util_1.HttpError(400, '需要 lineId（正整数）指定待拆分的行');
        if (splitCp == null)
            throw new util_1.HttpError(400, '需要 splitCp（整数，按 Unicode 码点计的行内拆分点）');
        const ctx = await loadSplitCtx(client, doc.id, lineId, opts.forUpdate);
        if (opts.requireBasis)
            checkBasis(splitBasis(ctx), opts.basis);
        const plan = computeSplitPlan(ctx, splitCp);
        return { kind: 'split', plan, ctx };
    }
    const leftLineId = toInt(raw.leftLineId);
    const rightLineId = toInt(raw.rightLineId);
    if (leftLineId == null || leftLineId <= 0 || rightLineId == null || rightLineId <= 0) {
        throw new util_1.HttpError(400, '需要 leftLineId 与 rightLineId（正整数）指定相邻两行');
    }
    const ctx = await loadMergeCtx(client, doc.id, leftLineId, rightLineId, opts.forUpdate);
    if (opts.requireBasis)
        checkBasis(mergeBasis(ctx), opts.basis);
    const plan = computeMergePlan(ctx);
    return { kind: 'merge', plan, ctx };
}
/** 执行拆分计划（调用方须已持有文献行锁并核对版本 / basis）。 */
async function applySplitPlan(client, ctx, plan) {
    const n = ctx.line.line_no;
    const splitCp = plan.splitCp;
    const leftContent = (0, util_1.sliceCp)(ctx.line.content, 0, splitCp);
    const rightContent = (0, util_1.sliceCp)(ctx.line.content, splitCp, (0, util_1.charLen)(ctx.line.content));
    // 1) 后续行号 +1（按行号倒序逐行，避免 (ms_id, line_no) 唯一约束的瞬时冲突）
    const later = ctx.msLines.filter((l) => l.line_no > n).sort((a, b) => b.line_no - a.line_no);
    for (const l of later) {
        await client.query('UPDATE lines SET line_no=$1 WHERE id=$2', [l.line_no + 1, l.id]);
    }
    // 2) 左段保留原行 id
    await client.query('UPDATE lines SET content=$1 WHERE id=$2', [leftContent, ctx.line.id]);
    // 3) 右段成为新行
    const { rows } = await client.query('INSERT INTO lines (ms_id, line_no, content) VALUES ($1,$2,$3) RETURNING id', [ctx.ms.id, n + 1, rightContent]);
    const newLineId = rows[0].id;
    // 4) 拆分点之后的片段迁至新行并重算区间；跨点片段保留原行原区间（可追溯）
    for (const f of plan.fragments) {
        if (f.status !== 'moved')
            continue;
        await client.query('UPDATE fragments SET line_id=$1, start_cp=$2, end_cp=$3 WHERE id=$4', [
            newLineId,
            f.newStartCp,
            f.newEndCp,
            f.fragmentId,
        ]);
        f.newLineId = newLineId; // 回填，提交响应中给出新行 id
    }
    const splitRight = plan.lines.find((l) => l.origin === 'split-right');
    if (splitRight)
        splitRight.lineId = newLineId;
    // 5) 跨点片段所在组 → 待修复（只增不减；原已待修复组自然保持）
    const newlyBroken = plan.brokenGroups.filter((b) => b.newlyBroken).map((b) => b.groupId);
    if (newlyBroken.length > 0) {
        await client.query('UPDATE grp SET broken=TRUE WHERE id = ANY($1::bigint[])', [newlyBroken]);
    }
}
/** 执行合并计划：右行片段先迁至左行，再合并内容、删除右行、行号顺移。 */
async function applyMergePlan(client, ctx, plan) {
    // 1) 右行片段迁至左行（先迁移再删行：lines 删除会级联删除其片段）
    for (const f of plan.fragments) {
        if (f.status !== 'moved')
            continue;
        await client.query('UPDATE fragments SET line_id=$1, start_cp=$2, end_cp=$3 WHERE id=$4', [
            ctx.left.id,
            f.newStartCp,
            f.newEndCp,
            f.fragmentId,
        ]);
    }
    // 2) 左行内容 = 左 + 右（字序不变）
    await client.query('UPDATE lines SET content=$1 WHERE id=$2', [
        ctx.left.content + ctx.right.content,
        ctx.left.id,
    ]);
    // 3) 删除右行
    await client.query('DELETE FROM lines WHERE id=$1', [ctx.right.id]);
    // 4) 后续行号 -1（按行号升序逐行）
    const later = ctx.msLines.filter((l) => l.line_no > ctx.right.line_no).sort((a, b) => a.line_no - b.line_no);
    for (const l of later) {
        await client.query('UPDATE lines SET line_no=$1 WHERE id=$2', [l.line_no - 1, l.id]);
    }
}
/** 应用已计算的计划（拆分 / 合并）。 */
async function applyReLinePlan(client, built) {
    if (built.kind === 'split')
        await applySplitPlan(client, built.ctx, built.plan);
    else
        await applyMergePlan(client, built.ctx, built.plan);
}
