"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadSupplementData = loadSupplementData;
exports.computePreview = computePreview;
exports.recheckSelections = recheckSelections;
const util_1 = require("./util");
async function loadSupplementData(client, docId, baseMsId, targetMsId) {
    const { rows: mss } = await client.query('SELECT id, doc_id, name, position FROM manuscripts WHERE doc_id=$1 ORDER BY position, id', [docId]);
    const { rows: groups } = await client.query('SELECT id, doc_id, ord, broken FROM grp WHERE doc_id=$1 ORDER BY ord', [docId]);
    const { rows: fragments } = await client.query('SELECT id, group_id, doc_id, ms_id, line_id, start_cp, end_cp, missing FROM fragments WHERE doc_id=$1 ORDER BY id', [docId]);
    const lineMsIds = Array.from(new Set([baseMsId, targetMsId].filter((x) => x != null)));
    const { rows: lines } = await client.query(`SELECT id, ms_id, line_no, content FROM lines
     WHERE ms_id = ANY($1::bigint[]) ORDER BY ms_id, line_no`, [lineMsIds]);
    return {
        mss,
        groups,
        fragments,
        baseLines: lines.filter((l) => l.ms_id === baseMsId),
        targetLines: lines.filter((l) => l.ms_id === targetMsId),
    };
}
/**
 * 计算补配预览：
 *  - 仅考虑目标抄本“尚无片段且未标缺文”的完好组（待修复组不参与）；
 *  - 候选 = 该抄本某一行内与底本文字逐码点完整相同、且不占用任何现存片段区间的出现处；
 *  - 组内多处 → multiple；无 → none；唯一但与其他组候选区间重叠 → conflict；
 *    唯一且无冲突 → unique（可直接采纳）。
 */
function computePreview(data, docId, version, baseMsId, targetMsId) {
    const targetMs = data.mss.find((m) => m.id === targetMsId);
    const baseLineById = new Map(data.baseLines.map((l) => [l.id, l]));
    const targetLineById = new Map(data.targetLines.map((l) => [l.id, l]));
    const fragsByGroup = new Map();
    for (const f of data.fragments) {
        const arr = fragsByGroup.get(f.group_id) ?? [];
        arr.push(f);
        fragsByGroup.set(f.group_id, arr);
    }
    // 目标抄本每一行被现存真实片段占用的码点区间（含待修复组片段；端点相接不算占用）
    const occupiedByLine = new Map();
    for (const f of data.fragments) {
        if (f.ms_id !== targetMsId || f.missing || f.line_id == null || f.start_cp == null || f.end_cp == null)
            continue;
        const arr = occupiedByLine.get(f.line_id) ?? [];
        arr.push({ s: f.start_cp, e: f.end_cp });
        occupiedByLine.set(f.line_id, arr);
    }
    /** 取完好底本片段的确定文字；不可用返回 null。 */
    const baseTextOf = (g) => {
        if (g.broken || baseMsId == null)
            return null;
        const bf = (fragsByGroup.get(g.id) ?? []).find((f) => f.ms_id === baseMsId && !f.missing);
        if (!bf || bf.line_id == null || bf.start_cp == null || bf.end_cp == null)
            return null;
        const ln = baseLineById.get(bf.line_id);
        if (!ln)
            return null;
        const len = (0, util_1.charLen)(ln.content);
        if (bf.start_cp < 0 || bf.end_cp <= bf.start_cp || bf.start_cp >= len || bf.end_cp > len)
            return null;
        return (0, util_1.sliceCp)(ln.content, bf.start_cp, bf.end_cp);
    };
    const allOccurrences = (line, needle) => {
        const chars = Array.from(line.content);
        const pat = Array.from(needle);
        const out = [];
        if (pat.length === 0)
            return out;
        for (let i = 0; i + pat.length <= chars.length; i++) {
            let hit = true;
            for (let j = 0; j < pat.length; j++) {
                if (chars[i + j] !== pat[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit)
                out.push({ s: i, e: i + pat.length });
        }
        return out;
    };
    const internals = data.groups.map((g) => {
        const base = {
            groupId: g.id,
            ord: g.ord,
            baseText: '',
            status: 'none',
            adoptable: false,
            reason: '',
            candidates: [],
            eligible: false,
        };
        const tFrags = (fragsByGroup.get(g.id) ?? []).filter((f) => f.ms_id === targetMsId);
        const hasMissing = tFrags.some((f) => f.missing);
        const hasReal = tFrags.some((f) => !f.missing);
        const baseText = baseTextOf(g);
        if (g.broken) {
            base.reason = '待修复组不参与补配';
            return base;
        }
        if (hasMissing) {
            base.reason = '该抄本对此组已显式标为缺文，不参与补配';
            return base;
        }
        if (hasReal) {
            base.reason = '该抄本对此组已存在片段，无需补配';
            return base;
        }
        if (baseText == null) {
            base.reason = '底本文字不可用（底本片段缺失或越界），无法补配';
            return base;
        }
        if ((0, util_1.charLen)(baseText) === 0) {
            base.reason = '底本文字为空，无法补配';
            return base;
        }
        base.eligible = true;
        base.baseText = baseText;
        const candidates = [];
        for (const ln of data.targetLines) {
            const occupied = occupiedByLine.get(ln.id) ?? [];
            for (const occ of allOccurrences(ln, baseText)) {
                if (occupied.some((o) => (0, util_1.rangesOverlap)(o.s, o.e, occ.s, occ.e)))
                    continue; // 不占现存片段区间
                candidates.push({
                    lineId: ln.id,
                    lineNo: ln.line_no,
                    startCp: occ.s,
                    endCp: occ.e,
                    text: baseText,
                    conflictsWithGroupIds: [],
                });
            }
        }
        if (candidates.length === 0) {
            base.status = 'none';
            base.reason = '无候选：该抄本行文的空闲区间内没有与底本文字完整相同的单行文字';
            return base;
        }
        base.candidates = candidates;
        if (candidates.length > 1) {
            base.status = 'multiple';
            base.reason = `多个候选：在 ${candidates.length} 处空闲位置发现相同文字，需人工选定一处或跳过`;
        }
        return base;
    });
    // 组间候选冲突：不同组的候选在同一抄本同一行区间重叠。
    const eligible = internals.filter((g) => g.eligible && g.candidates.length > 0);
    for (const g of eligible) {
        for (const cand of g.candidates) {
            const hits = new Set();
            for (const other of eligible) {
                if (other.groupId === g.groupId)
                    continue;
                for (const oc of other.candidates) {
                    if (oc.lineId === cand.lineId && (0, util_1.rangesOverlap)(oc.startCp, oc.endCp, cand.startCp, cand.endCp)) {
                        hits.add(other.groupId);
                    }
                }
            }
            cand.conflictsWithGroupIds = [...hits].sort((a, b) => a - b);
        }
    }
    for (const g of eligible) {
        if (g.candidates.length > 1) {
            g.status = 'multiple';
            // multiple 保留：列出冲突供人工参考
            if (g.candidates.some((c) => c.conflictsWithGroupIds.length > 0)) {
                g.reason += '；且部分候选与其他组候选区间重叠，选定后仍需在提交时通过整批核对';
            }
            continue;
        }
        const only = g.candidates[0];
        if (only.conflictsWithGroupIds.length > 0) {
            g.status = 'conflict';
            const ords = only.conflictsWithGroupIds
                .map((id) => eligible.find((x) => x.groupId === id)?.ord)
                .filter((o) => o != null);
            g.reason =
                `候选唯一，但第 ${only.lineNo} 行第 ${only.startCp + 1}–${only.endCp} 字与` +
                    `第 ${ords.join('、')} 组候选区间重叠，需人工选定或跳过`;
        }
        else {
            g.status = 'unique';
            g.adoptable = true;
            g.reason = '候选唯一且无冲突，可直接采纳';
        }
    }
    const groups = internals
        .filter((g) => g.eligible)
        .map(({ eligible: _eligible, ...rest }) => rest);
    return {
        documentId: docId,
        version,
        baseMsId,
        targetMsId,
        targetMsName: targetMs?.name ?? `#${targetMsId}`,
        eligibleGroupCount: groups.length,
        excludedGroupCount: internals.length - groups.length,
        groups,
    };
}
/**
 * 在当前工作版重新核对提交的候选：
 * 组仍存在且完好、目标抄本仍无片段且未标缺文、区间落在自己行内、
 * 文字与底本文字完整相同、不占任何现存片段区间、各所选候选彼此不重叠。
 * 问题逐条返回（含行号/区间），调用方据此拒绝整批。
 */
function recheckSelections(data, selections, baseMsId) {
    const issues = [];
    const groupById = new Map(data.groups.map((g) => [g.id, g]));
    const targetLineById = new Map(data.targetLines.map((l) => [l.id, l]));
    const baseLineById = new Map(data.baseLines.map((l) => [l.id, l]));
    const fragsByGroup = new Map();
    for (const f of data.fragments) {
        const arr = fragsByGroup.get(f.group_id) ?? [];
        arr.push(f);
        fragsByGroup.set(f.group_id, arr);
    }
    const baseTextOf = (g) => {
        if (g.broken || baseMsId == null)
            return null;
        const bf = (fragsByGroup.get(g.id) ?? []).find((f) => f.ms_id === baseMsId && !f.missing);
        if (!bf || bf.line_id == null || bf.start_cp == null || bf.end_cp == null)
            return null;
        const ln = baseLineById.get(bf.line_id);
        if (!ln)
            return null;
        const len = (0, util_1.charLen)(ln.content);
        if (bf.start_cp < 0 || bf.end_cp <= bf.start_cp || bf.start_cp >= len || bf.end_cp > len)
            return null;
        return (0, util_1.sliceCp)(ln.content, bf.start_cp, bf.end_cp);
    };
    // 同一请求内组不得重复
    const seenGroup = new Set();
    const placed = [];
    for (const sel of selections) {
        const g = groupById.get(sel.groupId);
        if (!g) {
            issues.push({ code: 'GROUP_GONE', message: `候选失效：对应组 #${sel.groupId} 已不存在` });
            continue;
        }
        if (seenGroup.has(sel.groupId)) {
            issues.push({
                code: 'SELECTION_OVERLAP',
                message: `第 ${g.ord} 组在提交中出现了多个所选候选，每组至多采纳一处`,
                groupOrd: g.ord,
            });
        }
        seenGroup.add(sel.groupId);
        const tFrags = (fragsByGroup.get(g.id) ?? []).filter((f) => f.ms_id === sel.msId);
        if (tFrags.some((f) => f.missing)) {
            issues.push({
                code: 'TARGET_MISSING',
                message: `候选失效：第 ${g.ord} 组对该抄本已标为缺文`,
                groupOrd: g.ord,
            });
        }
        if (tFrags.some((f) => !f.missing)) {
            issues.push({
                code: 'ALREADY_HAS_FRAGMENT',
                message: `候选失效：第 ${g.ord} 组在该抄本已有片段，不能重复补配`,
                groupOrd: g.ord,
            });
        }
        if (g.broken) {
            issues.push({
                code: 'GROUP_BROKEN',
                message: `候选失效：第 ${g.ord} 组已变为待修复组，待修复组不参与补配`,
                groupOrd: g.ord,
            });
        }
        const ln = targetLineById.get(sel.lineId);
        if (!ln) {
            issues.push({
                code: 'BAD_LINE',
                message: `候选失效：第 ${g.ord} 组所选行 ${sel.lineId} 已不属于该抄本（行可能已删改）`,
                groupOrd: g.ord,
            });
            continue;
        }
        const baseText = baseTextOf(g);
        if (baseText == null || (0, util_1.charLen)(baseText) === 0) {
            issues.push({
                code: 'BASE_UNAVAILABLE',
                message: `候选失效：第 ${g.ord} 组底本文字当前不可用（底本切换 / 越界），请重新预览`,
                groupOrd: g.ord,
            });
            continue;
        }
        const len = (0, util_1.charLen)(ln.content);
        if (sel.startCp < 0 || sel.endCp <= sel.startCp || sel.startCp >= len || sel.endCp > len) {
            issues.push({
                code: 'OUT_OF_RANGE',
                message: `候选失效：第 ${g.ord} 组所选第 ${ln.line_no} 行区间 ` +
                    `[${sel.startCp}, ${sel.endCp}) 已越界（该行当前共 ${len} 字）`,
                groupOrd: g.ord,
                lineNo: ln.line_no,
                startCp: sel.startCp,
                endCp: sel.endCp,
            });
            continue;
        }
        const text = (0, util_1.sliceCp)(ln.content, sel.startCp, sel.endCp);
        if (text !== baseText) {
            issues.push({
                code: 'TEXT_MISMATCH',
                message: `候选失效：第 ${g.ord} 组所选第 ${ln.line_no} 行第 ${sel.startCp + 1}–${sel.endCp} 字` +
                    `当前文字为「${text}」，已不等于底本文字「${baseText}」`,
                groupOrd: g.ord,
                lineNo: ln.line_no,
                startCp: sel.startCp,
                endCp: sel.endCp,
            });
            continue;
        }
        // 不占任何现存片段区间（含其他待修复组片段）
        const occupied = data.fragments.filter((f) => f.ms_id === sel.msId && !f.missing && f.line_id === sel.lineId &&
            f.start_cp != null && f.end_cp != null);
        if (occupied.some((o) => (0, util_1.rangesOverlap)(o.start_cp, o.end_cp, sel.startCp, sel.endCp))) {
            issues.push({
                code: 'OCCUPIED',
                message: `候选失效：第 ${g.ord} 组所选第 ${ln.line_no} 行第 ${sel.startCp + 1}–${sel.endCp} 字` +
                    `区间已被其他片段占用`,
                groupOrd: g.ord,
                lineNo: ln.line_no,
                startCp: sel.startCp,
                endCp: sel.endCp,
            });
            continue;
        }
        placed.push({ groupId: g.id, ord: g.ord, lineId: sel.lineId, s: sel.startCp, e: sel.endCp });
    }
    // 同一批所选候选彼此不得在同一行区间重叠
    placed.sort((a, b) => a.lineId - b.lineId || a.s - b.s);
    for (let i = 1; i < placed.length; i++) {
        const a = placed[i - 1];
        const b = placed[i];
        if (a.lineId === b.lineId && (0, util_1.rangesOverlap)(a.s, a.e, b.s, b.e)) {
            issues.push({
                code: 'SELECTION_OVERLAP',
                message: `所选候选彼此冲突：第 ${a.ord} 组 [${a.s}, ${a.e}) 与第 ${b.ord} 组 [${b.s}, ${b.e}) ` +
                    `在同一行第 ${Math.max(a.s, b.s) + 1}–${Math.min(a.e, b.e)} 字重叠，每组至多保留一处`,
                groupOrd: b.ord,
            });
        }
    }
    return issues;
}
