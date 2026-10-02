"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseEdits = parseEdits;
exports.buildBatchEditPlan = buildBatchEditPlan;
exports.checkBatchEditBasis = checkBatchEditBasis;
exports.buildPlanForEdits = buildPlanForEdits;
exports.applyBatchEditPlan = applyBatchEditPlan;
const util_1 = require("./util");
/**
 * 解析请求体的 edits：非空数组；每项 lineId 正整数、startCp/endCp 非负整数且起≤止、
 * replacement 为字符串。形状问题逐条收集，整批抛出 400。
 */
function parseEdits(input) {
    if (!Array.isArray(input) || input.length === 0) {
        throw new util_1.HttpError(400, 'edits 必须为非空数组（每项含 lineId/startCp/endCp/replacement）');
    }
    const issues = [];
    const parsed = [];
    input.forEach((e, index) => {
        if (!e || typeof e !== 'object' || Array.isArray(e)) {
            issues.push({ code: 'BAD_SHAPE', index, message: `第 ${index + 1} 项不是对象` });
            return;
        }
        const x = e;
        if (!(0, util_1.isInt)(x.lineId) || x.lineId <= 0) {
            issues.push({ code: 'BAD_SHAPE', index, message: `第 ${index + 1} 项需要正整数 lineId` });
            return;
        }
        if (!(0, util_1.isInt)(x.startCp) || x.startCp < 0 || !(0, util_1.isInt)(x.endCp) || x.endCp < x.startCp) {
            issues.push({
                code: 'BAD_SHAPE',
                index,
                lineId: x.lineId,
                message: `第 ${index + 1} 项区间非法：startCp/endCp 需为非负整数且 startCp ≤ endCp`,
            });
            return;
        }
        if (typeof x.replacement !== 'string') {
            issues.push({
                code: 'BAD_SHAPE',
                index,
                lineId: x.lineId,
                message: `第 ${index + 1} 项 replacement 必须是字符串（删除传空串）`,
            });
            return;
        }
        parsed.push({
            index,
            lineId: x.lineId,
            startCp: x.startCp,
            endCp: x.endCp,
            replacement: x.replacement,
        });
    });
    if (issues.length > 0) {
        throw new util_1.HttpError(400, '批量行改请求格式有误，未写入任何内容', issues);
    }
    return parsed;
}
/** 装载被改行并加行锁；行不存在 → 404（一次列出全部缺失行），不属于本文献 → 400。 */
async function loadLineContexts(client, docId, edits, forUpdate) {
    const lineIds = [...new Set(edits.map((e) => e.lineId))];
    const { rows } = await client.query(`SELECT id, ms_id, line_no, content FROM lines WHERE id = ANY($1::bigint[])${forUpdate ? ' FOR UPDATE' : ''}`, [lineIds]);
    const missing = lineIds.filter((id) => !rows.some((l) => l.id === id));
    if (missing.length > 0) {
        throw new util_1.HttpError(404, `行 #${missing.join('、#')} 不存在`, { lineIds: missing });
    }
    const msIds = [...new Set(rows.map((l) => l.ms_id))];
    const { rows: msRows } = await client.query('SELECT id, doc_id, name, position FROM manuscripts WHERE id = ANY($1::bigint[])', [msIds]);
    const msById = new Map(msRows.map((m) => [m.id, m]));
    const issues = [];
    const byLine = new Map();
    for (const line of rows) {
        const ms = msById.get(line.ms_id);
        if (!ms || ms.doc_id !== docId) {
            for (const e of edits.filter((x) => x.lineId === line.id)) {
                issues.push({
                    code: 'LINE_NOT_IN_DOC',
                    index: e.index,
                    lineId: line.id,
                    message: `第 ${e.index + 1} 项：行 #${line.id} 不属于文献 #${docId}，已拒绝整批`,
                });
            }
            continue;
        }
        const lineEdits = edits
            .filter((e) => e.lineId === line.id)
            .sort((a, b) => a.startCp - b.startCp || a.endCp - b.endCp || a.index - b.index);
        byLine.set(line.id, { line, ms, edits: lineEdits });
    }
    if (issues.length > 0) {
        throw new util_1.HttpError(400, '批量行改含跨文献行，已拒绝整批、未写入任何内容', issues);
    }
    return byLine;
}
/**
 * 逐行检查：区间合法（基于改前原文长度）、区间不重叠、
 * 同点重复插入、插入点落在其他编辑区间内或端点上。
 * 问题逐条收集后整批抛出（400，定位到行 / 请求项下标 / 码点）。
 */
function validatePerLine(byLine) {
    const issues = [];
    for (const ctx of byLine.values()) {
        const len = (0, util_1.charLen)(ctx.line.content);
        // 区间越界
        for (const e of ctx.edits) {
            if (e.startCp > len || e.endCp > len) {
                issues.push({
                    code: 'BAD_RANGE',
                    index: e.index,
                    lineId: ctx.line.id,
                    lineNo: ctx.line.line_no,
                    startCp: e.startCp,
                    endCp: e.endCp,
                    message: `第 ${e.index + 1} 项：第 ${ctx.line.line_no} 行（${ctx.ms.name}）共 ${len} 字，` +
                        `区间 [${e.startCp}, ${e.endCp}) 越界；合法范围为 [0, ${len}]`,
                });
            }
        }
        // 两两关系：区间重叠 / 同点重复插入 / 插入点落入他区间内或端点
        const reported = new Set();
        const report = (issue) => {
            const key = `${issue.code}:${issue.indices?.join('~') ?? issue.index}:${issue.point ?? ''}`;
            if (reported.has(key))
                return;
            reported.add(key);
            issues.push(issue);
        };
        const es = ctx.edits;
        for (let i = 0; i < es.length; i++) {
            for (let j = i + 1; j < es.length; j++) {
                const a = es[i];
                const b = es[j];
                const zeroA = a.startCp === a.endCp;
                const zeroB = b.startCp === b.endCp;
                if (zeroA && zeroB) {
                    if (a.startCp === b.startCp) {
                        report({
                            code: 'DUPLICATE_INSERTION',
                            indices: [a.index, b.index],
                            lineId: ctx.line.id,
                            lineNo: ctx.line.line_no,
                            point: a.startCp,
                            message: `第 ${a.index + 1}、${b.index + 1} 项：在第 ${ctx.line.line_no} 行（${ctx.ms.name}）` +
                                `同一插入点 ${a.startCp} 重复插入，已拒绝整批`,
                        });
                    }
                    continue; // 两个不同点的插入互不相交
                }
                if (zeroA || zeroB) {
                    const z = zeroA ? a : b;
                    const r = zeroA ? b : a;
                    if (r.startCp <= z.startCp && z.startCp <= r.endCp) {
                        // 编辑之间严格内部与端点都拒绝（端点只在“片段边界”处允许，不允许在“编辑边界”）
                        const atEdge = z.startCp === r.startCp || z.startCp === r.endCp;
                        report({
                            code: 'INSERTION_POINT_IN_INTERVAL',
                            indices: [a.index, b.index],
                            lineId: ctx.line.id,
                            lineNo: ctx.line.line_no,
                            point: z.startCp,
                            startCp: r.startCp,
                            endCp: r.endCp,
                            message: `第 ${Math.min(a.index, b.index) + 1}、${Math.max(a.index, b.index) + 1} 项：` +
                                `第 ${ctx.line.line_no} 行（${ctx.ms.name}）插入点 ${z.startCp} ` +
                                (atEdge
                                    ? `落在编辑区间 [${r.startCp}, ${r.endCp}) 的端点上`
                                    : `落在编辑区间 [${r.startCp}, ${r.endCp}) 内`) +
                                '；同一行编辑须互不相交（端点相接须分属两个非零长编辑），已拒绝整批',
                        });
                    }
                    continue;
                }
                // 两个非零长区间：半开区间相交（端点相接不算重叠）
                if (a.startCp < b.endCp && b.startCp < a.endCp) {
                    report({
                        code: 'OVERLAPPING_RANGES',
                        indices: [a.index, b.index],
                        lineId: ctx.line.id,
                        lineNo: ctx.line.line_no,
                        startCp: Math.max(a.startCp, b.startCp),
                        endCp: Math.min(a.endCp, b.endCp),
                        message: `第 ${a.index + 1}、${b.index + 1} 项：第 ${ctx.line.line_no} 行（${ctx.ms.name}）` +
                            `编辑区间 [${a.startCp}, ${a.endCp}) 与 [${b.startCp}, ${b.endCp}) 重叠，已拒绝整批`,
                    });
                }
            }
        }
    }
    if (issues.length > 0) {
        throw new util_1.HttpError(400, `批量行改含 ${issues.length} 处冲突 / 非法编辑，已拒绝整批、未写入任何内容`, issues);
    }
}
/** 取被改行上的全部真实片段（含待修复组现存片段）及其所属组；缺文标记不依附行，永不在此列。 */
async function loadFragments(client, docId, lineIds) {
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
/** 同一行编辑按原坐标排序并附加替换长度 / 位移（编辑已校验为互不相交）。 */
function normalizeEdits(edits) {
    return edits.map((e) => ({
        ...e,
        replLen: (0, util_1.charLen)(e.replacement),
        delta: (0, util_1.charLen)(e.replacement) - (e.endCp - e.startCp),
    }));
}
/** 按原坐标同时生效：编辑互不相交，沿原码点序列逐段拼接（生僻字按码点安全）。 */
function composeContent(oldContent, edits) {
    const chars = Array.from(oldContent);
    const out = [];
    let cursor = 0;
    for (const e of edits) {
        out.push(...chars.slice(cursor, e.startCp));
        out.push(...Array.from(e.replacement));
        cursor = e.endCp;
    }
    out.push(...chars.slice(cursor));
    return out.join('');
}
/** 上下文按抄本次序、行号排序（用于行计划 / 片段输出的稳定次序）。 */
function orderedContexts(contexts) {
    return [...contexts.values()].sort((a, b) => a.ms.position - b.ms.position || a.ms.id - b.ms.id || a.line.line_no - b.line.line_no);
}
/**
 * 计算整份预览计划：每行新文字、每个受影响片段的新位置与待修复组。
 */
function buildBatchEditPlan(contexts, fragRows) {
    const linePlans = [];
    const editsByLine = new Map();
    for (const ctx of orderedContexts(contexts)) {
        const norm = normalizeEdits(ctx.edits);
        editsByLine.set(ctx.line.id, norm);
        const newContent = composeContent(ctx.line.content, norm);
        linePlans.push({
            lineId: ctx.line.id,
            lineNo: ctx.line.line_no,
            msId: ctx.ms.id,
            msName: ctx.ms.name,
            oldContent: ctx.line.content,
            newContent,
            oldLengthCp: (0, util_1.charLen)(ctx.line.content),
            newLengthCp: (0, util_1.charLen)(newContent),
            edits: norm.map((e) => ({
                index: e.index,
                startCp: e.startCp,
                endCp: e.endCp,
                replacement: e.replacement,
                replacementLengthCp: e.replLen,
            })),
        });
    }
    const fragments = [];
    const brokenGroups = [];
    const listedGroups = new Set(); // 已列入 brokenGroups 的组（去重）
    /**
     * 列入受影响组：
     *  - 原已待修复组：编辑行上只要有其真实片段就列出（含片段完全位于编辑之前的情形），
     *    批量行改绝不让待修复组自动转好；
     *  - 新待修复组：相交 / 越界首次发现时列入；若同组另有片段是“原已待修复”，仍以原状态为准。
     */
    const listBroken = (grp, newly, reason) => {
        const existing = listedGroups.has(grp.id);
        if (grp.broken)
            newly = false; // 组当前已待修复 → 永远不可能是“新标”
        if (existing)
            return;
        listedGroups.add(grp.id);
        brokenGroups.push({ groupId: grp.id, ord: grp.ord, newlyBroken: newly, reason });
    };
    // 编辑行上有真实片段的“原已待修复组”先全部列入（不受影响的也列出，显式说明不会自动转好）
    for (const { grp } of fragRows) {
        if (grp.broken)
            listBroken(grp, false, `第 ${grp.ord} 组原已待修复，批量行改后保持待修复（不自动转为完好）`);
    }
    const newLenByLine = new Map(linePlans.map((p) => [p.lineId, p.newLengthCp]));
    for (const { frag, grp } of fragRows) {
        const lineId = frag.line_id;
        const ctx = contexts.get(lineId);
        if (!ctx)
            continue;
        const edits = editsByLine.get(lineId) ?? [];
        const s = frag.start_cp;
        const e = frag.end_cp;
        const base = {
            fragmentId: frag.id,
            groupId: grp.id,
            groupOrd: grp.ord,
            groupAlreadyBroken: grp.broken,
            msId: frag.ms_id,
            lineId,
            lineNo: ctx.line.line_no,
            oldStartCp: s,
            oldEndCp: e,
        };
        // 逐编辑（按原坐标）判定：相交立即待修复——零长编辑仅在严格位于片段内部时相交，
        // 位于片段边界只平移后续片段；不相交则按累计位移平移。
        let ns = s;
        let ne = e;
        let hitEdit = null;
        for (const ed of edits) {
            const zero = ed.startCp === ed.endCp;
            if (zero) {
                if (s < ed.startCp && ed.startCp < e) {
                    hitEdit = { zero: true, point: ed.startCp, rS: ed.startCp, rE: ed.endCp };
                    break;
                }
                if (s >= ed.startCp) {
                    ns += ed.delta; // 插入点在片段起点（边界）：片段位于插入点之后 → 仅平移
                    ne += ed.delta;
                }
            }
            else {
                if (s < ed.endCp && ed.startCp < e) {
                    hitEdit = { zero: false, point: -1, rS: ed.startCp, rE: ed.endCp };
                    break;
                }
                if (s >= ed.endCp) {
                    ns += ed.delta;
                    ne += ed.delta;
                }
            }
        }
        if (hitEdit) {
            fragments.push({
                ...base,
                status: 'broken',
                newStartCp: s, // 相交：保留原区间坐标，留待研究者修复（与单行改字一致、可追溯）
                newEndCp: e,
                note: hitEdit.zero
                    ? `插入点 ${hitEdit.point} 严格位于片段 [${s}, ${e}) 内部：保留原区间坐标，所在组待修复`
                    : `片段 [${s}, ${e}) 与编辑区间 [${hitEdit.rS}, ${hitEdit.rE}) 相交：保留原区间坐标，所在组待修复`,
            });
            if (grp.broken) {
                listBroken(grp, false, `第 ${grp.ord} 组原已待修复，批量行改后保持待修复（不自动转为完好）`);
            }
            else {
                listBroken(grp, true, hitEdit.zero
                    ? `第 ${grp.ord} 组片段 [${s}, ${e}) 内的插入点 ${hitEdit.point} 严格位于片段内部，标为待修复`
                    : `第 ${grp.ord} 组片段 [${s}, ${e}) 与编辑区间 [${hitEdit.rS}, ${hitEdit.rE}) 相交，标为待修复`);
            }
            continue;
        }
        // 平移后越界（缩行）→ 待修复；保留平移后坐标以便追溯
        const newLen = newLenByLine.get(lineId);
        if (ns < 0 || ne <= ns || ns > newLen || ne > newLen) {
            fragments.push({
                ...base,
                status: 'broken',
                newStartCp: ns,
                newEndCp: ne,
                note: `片段平移为 [${ns}, ${ne}) 后超出新行长 ${newLen}（缩行越界）：所在组待修复`,
            });
            if (grp.broken) {
                listBroken(grp, false, `第 ${grp.ord} 组原已待修复，批量行改后保持待修复（不自动转为完好）`);
            }
            else {
                listBroken(grp, true, `第 ${grp.ord} 组片段平移后越界（新区间 [${ns}, ${ne})，新行长 ${newLen}），标为待修复`);
            }
            continue;
        }
        const moved = ns !== s || ne !== e;
        fragments.push({
            ...base,
            status: moved ? 'moved' : 'unchanged',
            newStartCp: ns,
            newEndCp: ne,
            note: moved
                ? `片段不与任何编辑相交，按累计位移平移为 [${ns}, ${ne})`
                : '片段位于所有编辑之前，位置不变',
        });
        if (grp.broken) {
            listBroken(grp, false, `第 ${grp.ord} 组原已待修复，批量行改后保持待修复（不自动转为完好）`);
        }
    }
    const basis = linePlans.map((p) => ({
        lineId: p.lineId,
        lineNo: p.lineNo,
        msId: p.msId,
        msName: p.msName,
        content: p.oldContent,
        lengthCp: p.oldLengthCp,
    }));
    // 片段按 抄本序 / 行号 / 原起点 稳定排序
    const orderIndex = new Map();
    orderedContexts(contexts).forEach((c, i) => orderIndex.set(c.line.id, i));
    fragments.sort((a, b) => (orderIndex.get(a.lineId) ?? 0) - (orderIndex.get(b.lineId) ?? 0) ||
        a.oldStartCp - b.oldStartCp ||
        a.fragmentId - b.fragmentId);
    brokenGroups.sort((a, b) => a.ord - b.ord);
    return { basis, lines: linePlans, fragments, brokenGroups };
}
/**
 * 提交时核对预览所依据的行：缺 basis → 400；行集合不一致或任一行内容 / 行号 /
 * 所属抄本与当前不符 → 409 BATCH_EDIT_STALE，整次拒绝。
 * （版本一致时行必然未变；此核对为显式兜底，并防止 basis 张冠李戴。）
 */
function checkBatchEditBasis(actual, given) {
    const lines = Array.isArray(given)
        ? given
        : given?.lines;
    if (!Array.isArray(lines)) {
        throw new util_1.HttpError(400, '缺少 basis：请原样带回预览响应中的 basis（行状态数组），以确认预览所依据的行未变化');
    }
    const actualById = new Map(actual.map((b) => [b.lineId, b]));
    const givenIds = new Set();
    const issues = [];
    for (const item of lines) {
        const x = item;
        if (!x || typeof x !== 'object' || !(0, util_1.isInt)(x.lineId)) {
            issues.push('basis 中存在无法识别的条目');
            continue;
        }
        givenIds.add(x.lineId);
        const a = actualById.get(x.lineId);
        if (!a) {
            issues.push(`行 #${x.lineId} 已不在本批编辑所依据的行集合中（可能已删除）`);
            continue;
        }
        if (x.lineNo !== a.lineNo || x.content !== a.content || x.lengthCp !== a.lengthCp || x.msId !== a.msId) {
            issues.push(`行 #${x.lineId}（第 ${a.lineNo} 行）内容或行号已变化`);
        }
    }
    for (const id of actualById.keys()) {
        if (!givenIds.has(id))
            issues.push(`缺少行 #${id} 的 basis（预览行集合与提交不一致）`);
    }
    if (issues.length > 0) {
        throw new util_1.HttpError(409, '预览所依据的行已变化，已整次拒绝、未写入任何内容，请重新预览后再确认', {
            code: 'BATCH_EDIT_STALE',
            issues,
        });
    }
}
/** 装载 + 校验 + 计算计划（预览 / 提交共用）。 */
async function buildPlanForEdits(client, doc, rawEdits, opts) {
    const edits = parseEdits(rawEdits);
    const contexts = await loadLineContexts(client, doc.id, edits, opts.forUpdate);
    validatePerLine(contexts);
    const fragRows = await loadFragments(client, doc.id, [...contexts.keys()]);
    const plan = buildBatchEditPlan(contexts, fragRows);
    if (opts.requireBasis)
        checkBatchEditBasis(plan.basis, opts.basis);
    return { plan, contexts };
}
/**
 * 应用计划：更新各行内容、平移未受影响片段；
 * 相交片段保留原坐标、越界片段保留平移后坐标，仅将所在组置为待修复。
 */
async function applyBatchEditPlan(client, plan) {
    for (const l of plan.lines) {
        await client.query('UPDATE lines SET content=$1 WHERE id=$2', [l.newContent, l.lineId]);
    }
    for (const f of plan.fragments) {
        if (f.status !== 'moved')
            continue; // unchanged 不动；broken 保留可追溯坐标
        await client.query('UPDATE fragments SET start_cp=$1, end_cp=$2 WHERE id=$3', [
            f.newStartCp,
            f.newEndCp,
            f.fragmentId,
        ]);
    }
    const newlyBroken = plan.brokenGroups.filter((g) => g.newlyBroken).map((g) => g.groupId);
    if (newlyBroken.length > 0) {
        await client.query('UPDATE grp SET broken=TRUE WHERE id = ANY($1::bigint[])', [newlyBroken]);
    }
}
