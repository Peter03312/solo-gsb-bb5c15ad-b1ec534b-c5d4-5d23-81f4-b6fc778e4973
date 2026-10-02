"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REVIEW = void 0;
exports.loadGroupData = loadGroupData;
exports.reconcileJudgments = reconcileJudgments;
exports.matchJudgmentToGroup = matchJudgmentToGroup;
exports.locKey = locKey;
exports.buildBaseLocationIndex = buildBaseLocationIndex;
exports.reattachJudgmentsForRegroup = reattachJudgmentsForRegroup;
exports.toJudgmentView = toJudgmentView;
exports.attachJudgmentsToView = attachJudgmentsToView;
exports.retargetJudgmentsForBaseSwitch = retargetJudgmentsForBaseSwitch;
exports.reconfirmJudgment = reconfirmJudgment;
exports.syncJudgmentsFromSnapshot = syncJudgmentsFromSnapshot;
const util_1 = require("./util");
/**
 * 判读意见（整理者对工作版对应组的判读）。
 *
 * 锚点：
 *  - 每条意见锚定「原组」——组的底本片段身份（底本抄本 + 该抄本原始行号 + 码点区间 + 底本文字）；
 *  - 已裁定意见额外锚定「所选片段」（所选抄本 + 原始行号 + 码点区间）与引用文字。
 *
 * 有效性（行文 / 底本 / 归组改变后）：
 *  - 保留片段标识的操作（行内改字 / 批量行改 / 行界调整 / 补配 / 单组修复 / 切底本）
 *    走 reconcileJudgments：随片段平移刷新锚点；组待修复、引用消失（缺文 / 失效）、引用文字已变
 *    则置 needs_review（闩锁只增不减，只能由人重新确认 / 撤回清除）。
 *  - 整批重存会更换全部组标识，走 reattachJudgmentsForRegroup：按与「版本对照」完全相同的
 *    底本位置唯一配对规则重新挂载；旧侧或新侧不唯一、引用文字已变 → 保持孤儿（待复核），
 *    绝不静默移到别组。
 */
// ---- 待复核原因（中文，可定位）----
exports.REVIEW = {
    groupBroken: (ord) => ord != null
        ? `第 ${ord} 组已待修复：请在修复后重新确认本组判读意见`
        : '原对应组已待修复：请重新确认本判读意见',
    groupDeleted: (ord) => ord != null
        ? `原第 ${ord} 组已删除：引用失效，请重新确认或撤回本意见（不会移到其他组）`
        : '原对应组已删除：引用失效，请重新确认或撤回本意见（不会移到其他组）',
    notUnique: (ord) => ord != null
        ? `第 ${ord} 组在最新归组中无法唯一对应：请重新确认或撤回本意见（不会移到其他组）`
        : '原对应组在最新归组中无法唯一对应：请重新确认或撤回本意见（不会移到其他组）',
    fragmentGone: (ord, msName) => `第 ${ord ?? '?'} 组中所选抄本${msName ? `「${msName}」` : ''}的片段已消失（被改为缺文或删除）：引用失效，请重新确认或撤回`,
    quoteChanged: (ord, msName, oldText, newText) => `第 ${ord ?? '?'} 组${msName ? `「${msName}」` : ''}引用文字已变：「${oldText}」→「${newText}」，请重新确认或撤回`,
    baseChanged: (ord) => ord != null
        ? `第 ${ord} 组的底本已切换：请按新底本重新确认本组判读意见`
        : '底本已切换：请重新确认本判读意见',
    chosenMsGone: (ord) => ord != null
        ? `第 ${ord} 组所选抄本已不存在：请重新确认或撤回本意见`
        : '所选抄本已不存在：请重新确认或撤回本意见',
};
/** 读取一篇文献的全部组 / 片段 / 行（调用方须在事务内；forUpdate 时对组与片段加行锁）。 */
async function loadGroupData(client, docId, forUpdate = false) {
    const lock = forUpdate ? ' FOR UPDATE' : '';
    const { rows: groups } = await client.query(`SELECT id, ord, broken FROM grp WHERE doc_id=$1 ORDER BY ord${lock}`, [docId]);
    const { rows: fragments } = await client.query(`SELECT id, group_id, ms_id, line_id, start_cp, end_cp, missing
     FROM fragments WHERE doc_id=$1${lock}`, [docId]);
    const { rows: mss } = await client.query('SELECT id FROM manuscripts WHERE doc_id=$1', [docId]);
    const { rows: lines } = await client.query(`SELECT id, ms_id, line_no, content FROM lines WHERE ms_id = ANY($1::bigint[])`, [mss.map((m) => m.id)]);
    return { groups, fragments, lines };
}
/** 判定某抄本在某组中的有效片段状态（与 collation.ts 的 CellView 规则一致）。 */
function cellState(g, fs, linesById, msId) {
    const f = fs.find((x) => x.ms_id === msId);
    if (!f)
        return { ok: false, cell: { missing: false } };
    if (f.missing)
        return { ok: false, cell: { missing: true } };
    const ln = f.line_id ? linesById.get(f.line_id) : undefined;
    if (!ln || ln.ms_id !== msId || f.start_cp == null || f.end_cp == null) {
        return { ok: false, cell: { missing: false } };
    }
    if (g.broken)
        return { ok: false, cell: { line: ln, startCp: f.start_cp, endCp: f.end_cp, missing: false } };
    const len = (0, util_1.charLen)(ln.content);
    const s = f.start_cp;
    const e = f.end_cp;
    if (s < 0 || e <= s || s > len || e > len) {
        return { ok: false, cell: { line: ln, startCp: s, endCp: e, missing: false } };
    }
    return { ok: true, cell: { line: ln, startCp: s, endCp: e, text: (0, util_1.sliceCp)(ln.content, s, e), missing: false } };
}
/**
 * 保留片段标识的改动（行改 / 批量行改 / 行界 / 补配 / 修复 / 切底本）之后对账：
 *  - 已待复核（闩锁）的意见：仅刷新仍有效底本锚点（用于未来展示），状态绝不自动转好；
 *  - 已裁定：组须完好、所选抄本片段仍有效且引用文字未变；否则置待复核并记原因；
 *  - 未裁定：组须完好（未裁定不锚定具体片段）；组待修复 → 待复核；
 *  - 组已消失（group_id 为空）不在此处理（整批重存 / 删除另有路径）。
 */
async function reconcileJudgments(client, docId) {
    const { rows: judgments } = await client.query('SELECT * FROM group_judgments WHERE doc_id=$1 FOR UPDATE', [docId]);
    if (judgments.length === 0)
        return;
    const data = await loadGroupData(client, docId, true);
    const groupById = new Map(data.groups.map((g) => [g.id, g]));
    const fragsByGroup = new Map();
    for (const f of data.fragments) {
        const arr = fragsByGroup.get(f.group_id) ?? [];
        arr.push(f);
        fragsByGroup.set(f.group_id, arr);
    }
    const linesById = new Map(data.lines.map((l) => [l.id, l]));
    const { rows: mss } = await client.query('SELECT id, name FROM manuscripts WHERE doc_id=$1 ORDER BY position, id', [docId]);
    const msNameById = new Map(mss.map((m) => [m.id, m.name]));
    for (const j of judgments) {
        if (j.group_id == null)
            continue; // 孤儿意见只能由人重新确认 / 撤回
        const g = groupById.get(j.group_id);
        if (!g) {
            // 组已删（单组删除路由通常已显式标记；此处兜底）
            await latchReview(client, j, exports.REVIEW.groupDeleted(j.base_line_no == null ? null : j.last_ord));
            continue;
        }
        const fs = fragsByGroup.get(j.group_id) ?? [];
        // 底本锚点：组仍完好则把底本片段当前位置 / 文字刷新回锚点（行改平移、行界迁移后仍对应同一片段）
        if (j.base_ms_id != null) {
            const base = cellState(g, fs, linesById, j.base_ms_id);
            if (base.ok && base.cell.line && base.cell.startCp != null && base.cell.endCp != null) {
                if (base.cell.line.line_no !== j.base_line_no ||
                    base.cell.startCp !== j.base_start_cp ||
                    base.cell.endCp !== j.base_end_cp ||
                    base.cell.text !== j.base_text) {
                    await client.query(`UPDATE group_judgments
               SET base_line_no=$1, base_start_cp=$2, base_end_cp=$3, base_text=$4, updated_at=now()
             WHERE id=$5`, [base.cell.line.line_no, base.cell.startCp, base.cell.endCp, base.cell.text, j.id]);
                }
            }
        }
        if (j.needs_review)
            continue; // 闩锁：绝不自动转好
        if (g.broken) {
            await latchReview(client, j, exports.REVIEW.groupBroken(g.ord));
            continue;
        }
        if (!j.decided) {
            // 未裁定：仅依附完好组；组在且完好即有效
            continue;
        }
        // 已裁定：所选片段必须仍有效、引用文字未变
        if (j.chosen_ms_id == null || !msNameById.has(j.chosen_ms_id)) {
            await latchReview(client, j, exports.REVIEW.chosenMsGone(g.ord));
            continue;
        }
        const chosen = cellState(g, fs, linesById, j.chosen_ms_id);
        const chosenName = msNameById.get(j.chosen_ms_id) ?? null;
        if (!chosen.ok) {
            await latchReview(client, j, exports.REVIEW.fragmentGone(g.ord, chosenName));
            continue;
        }
        const curText = chosen.cell.text ?? '';
        if (curText !== j.quote_text) {
            await latchReview(client, j, exports.REVIEW.quoteChanged(g.ord, chosenName, j.quote_text, curText));
            continue;
        }
        // 引用有效：刷新所选片段锚点（平移 / 行界迁移）
        if (chosen.cell.line &&
            chosen.cell.startCp != null &&
            chosen.cell.endCp != null &&
            (chosen.cell.line.id !== j.chosen_line_id ||
                chosen.cell.line.line_no !== j.chosen_line_no ||
                chosen.cell.startCp !== j.chosen_start_cp ||
                chosen.cell.endCp !== j.chosen_end_cp)) {
            await client.query(`UPDATE group_judgments
           SET chosen_line_id=$1, chosen_line_no=$2, chosen_start_cp=$3, chosen_end_cp=$4, updated_at=now()
         WHERE id=$5`, [chosen.cell.line.id, chosen.cell.line.line_no, chosen.cell.startCp, chosen.cell.endCp, j.id]);
        }
    }
}
async function latchReview(client, j, reason) {
    await client.query(`UPDATE group_judgments
       SET needs_review=TRUE, review_reason=$1, last_ord=COALESCE(last_ord, $2), updated_at=now()
     WHERE id=$3`, [reason, j.last_ord, j.id]);
}
/**
 * 以「底本片段位置（抄本 + 原始行号 + 码点区间）」为键做唯一配对。
 * 与版本对照（diff.ts）的配对规则一致：
 * 仅当某位置在两侧各自唯一并一一对应时才配对；不推断移动。
 * 已裁定意见还要求新组中所选抄本片段仍有效且引用文字未变。
 *
 * 返回每个意见的挂载结果；调用方据此 UPDATE（无法配对 → 保持孤儿 / 待复核）。
 */
function matchJudgmentToGroup(j, oldIndex, newIndex, newGroups, newFragsByGroup, newLinesById, newMsIds) {
    if (j.baseMsId == null ||
        j.baseLineNo == null ||
        j.baseStartCp == null ||
        j.baseEndCp == null) {
        return { reason: exports.REVIEW.notUnique(j.lastOrd) };
    }
    const key = locKey(j.baseMsId, j.baseLineNo, j.baseStartCp, j.baseEndCp);
    const oldHits = oldIndex.get(key) ?? [];
    const newHits = newIndex.get(key) ?? [];
    if (oldHits.length !== 1 || newHits.length !== 1) {
        return { reason: exports.REVIEW.notUnique(j.lastOrd) };
    }
    const ngId = newHits[0];
    const ng = newGroups.get(ngId);
    if (!ng)
        return { reason: exports.REVIEW.notUnique(j.lastOrd) };
    if (ng.broken)
        return { reason: exports.REVIEW.groupBroken(ng.ord) };
    // 底本位置相同且各自唯一 → 底本引用文字必须未变（位置内文字可能在行改后变化）
    const nfs = newFragsByGroup.get(ngId) ?? [];
    const baseCell = cellState({ broken: false }, nfs, newLinesById, j.baseMsId);
    if (!baseCell.ok || baseCell.cell.text !== j.baseText) {
        return { reason: exports.REVIEW.quoteChanged(ng.ord, null, j.baseText, baseCell.cell.text ?? '') };
    }
    if (!j.decided) {
        // 未裁定：原组唯一对应即继续有效
        return { attachGroupId: ngId };
    }
    // 已裁定：所选抄本片段仍须存在且引用文字未变
    if (j.chosenMsId == null || !newMsIds.has(j.chosenMsId)) {
        return { reason: exports.REVIEW.chosenMsGone(ng.ord) };
    }
    const chosen = cellState({ broken: false }, nfs, newLinesById, j.chosenMsId);
    if (!chosen.ok) {
        return { reason: exports.REVIEW.fragmentGone(ng.ord, null) };
    }
    if ((chosen.cell.text ?? '') !== j.quoteText) {
        return { reason: exports.REVIEW.quoteChanged(ng.ord, null, j.quoteText, chosen.cell.text ?? '') };
    }
    return { attachGroupId: ngId };
}
function locKey(msId, lineNo, startCp, endCp) {
    return `${msId}:${lineNo}:${startCp}:${endCp}`;
}
/** 构造 底本位置 → 组 id 列表 的索引（用于两侧唯一性判定）。 */
function buildBaseLocationIndex(groups, fragments, linesById, baseMsId) {
    const index = new Map();
    if (baseMsId == null)
        return index;
    const fragsByGroup = new Map();
    for (const f of fragments) {
        const arr = fragsByGroup.get(f.group_id) ?? [];
        arr.push(f);
        fragsByGroup.set(f.group_id, arr);
    }
    for (const g of groups) {
        const f = (fragsByGroup.get(g.id) ?? []).find((x) => x.ms_id === baseMsId && !x.missing);
        if (!f || f.line_id == null || f.start_cp == null || f.end_cp == null)
            continue;
        const ln = linesById.get(f.line_id);
        if (!ln || ln.ms_id !== baseMsId)
            continue;
        const key = locKey(baseMsId, ln.line_no, f.start_cp, f.end_cp);
        const arr = index.get(key) ?? [];
        arr.push(g.id);
        index.set(key, arr);
    }
    return index;
}
/**
 * 整批保存对应组之后重新挂载判读意见（在删除旧组之前调用方须先抓取旧数据与意见快照）。
 * 已待复核的意见一律保持孤儿（必须由人重新确认 / 撤回，不自动跟随）。
 * 每个意见独立配对：旧侧 / 新侧位置不唯一、底本或引用文字已变 → 孤儿待复核，绝不静默移到别组。
 */
async function reattachJudgmentsForRegroup(client, docId, old) {
    const { rows: judgments } = await client.query('SELECT * FROM group_judgments WHERE doc_id=$1 FOR UPDATE', [docId]);
    if (judgments.length === 0)
        return;
    const data = await loadGroupData(client, docId, true);
    const newLinesById = new Map(data.lines.map((l) => [l.id, l]));
    const newGroupsById = new Map(data.groups.map((g) => [g.id, g]));
    const newFragsByGroup = new Map();
    for (const f of data.fragments) {
        const arr = newFragsByGroup.get(f.group_id) ?? [];
        arr.push(f);
        newFragsByGroup.set(f.group_id, arr);
    }
    const newMsIds = new Set();
    const { rows: mss } = await client.query('SELECT id FROM manuscripts WHERE doc_id=$1', [docId]);
    mss.forEach((m) => newMsIds.add(m.id));
    const oldLinesById = new Map(old.lines.map((l) => [l.id, l]));
    const oldIndex = buildBaseLocationIndex(old.groups, old.fragments, oldLinesById, old.baseMsId);
    const newBaseId = old.baseMsId; // 整批保存不切底本；底本以文献当前设置为准（由调用方传入同值）
    const newIndex = buildBaseLocationIndex(data.groups, data.fragments, newLinesById, newBaseId);
    const oldOrdById = new Map(old.groups.map((g) => [g.id, g.ord]));
    for (const j0 of judgments) {
        const j = j0;
        // 记录最近组序用于追溯
        if (j.last_ord == null && j.group_id != null) {
            const ord = oldOrdById.get(j.group_id);
            if (ord != null) {
                await client.query('UPDATE group_judgments SET last_ord=$1 WHERE id=$2', [ord, j.id]);
            }
        }
        if (j.needs_review) {
            // 已待复核：整批重存不自动跟随，保持孤儿
            await detachOrphan(client, j, exports.REVIEW.notUnique(oldOrdById.get(j.group_id ?? -1) ?? j.last_ord));
            continue;
        }
        const m = matchJudgmentToGroup({
            decided: j.decided,
            needs_review: j.needs_review,
            baseMsId: j.base_ms_id,
            baseLineNo: j.base_line_no,
            baseStartCp: j.base_start_cp,
            baseEndCp: j.base_end_cp,
            baseText: j.base_text,
            chosenMsId: j.chosen_ms_id,
            quoteText: j.quote_text,
            lastOrd: oldOrdById.get(j.group_id ?? -1) ?? j.last_ord,
        }, oldIndex, newIndex, newGroupsById, newFragsByGroup, newLinesById, newMsIds);
        if (m.attachGroupId != null) {
            const ng = newGroupsById.get(m.attachGroupId);
            // 刷新全部锚点为新组当前坐标
            const nfs = newFragsByGroup.get(m.attachGroupId) ?? [];
            await attachToGroup(client, j, m.attachGroupId, ng?.ord ?? null, nfs, newLinesById, old.baseMsId, j.chosen_ms_id);
        }
        else {
            await detachOrphan(client, j, m.reason ?? exports.REVIEW.notUnique(oldOrdById.get(j.group_id ?? -1) ?? j.last_ord));
        }
    }
}
/** 挂载意见到新组：刷新 group_id / 底本锚点 / 所选片段锚点，保留有效状态。 */
async function attachToGroup(client, j, newGroupId, newOrd, nfs, linesById, baseMsId, chosenMsId) {
    let baseLineNo = j.base_line_no;
    let baseStart = j.base_start_cp;
    let baseEnd = j.base_end_cp;
    let baseText = j.base_text;
    let chosenLineId = j.chosen_line_id;
    let chosenLineNo = j.chosen_line_no;
    let chosenStart = j.chosen_start_cp;
    let chosenEnd = j.chosen_end_cp;
    if (baseMsId != null) {
        const bf = nfs.find((x) => x.ms_id === baseMsId && !x.missing);
        const bln = bf?.line_id != null ? linesById.get(bf.line_id) : undefined;
        if (bf && bln && bf.start_cp != null && bf.end_cp != null && bln.ms_id === baseMsId) {
            const len = (0, util_1.charLen)(bln.content);
            if (bf.start_cp >= 0 && bf.end_cp <= len && bf.end_cp > bf.start_cp) {
                baseLineNo = bln.line_no;
                baseStart = bf.start_cp;
                baseEnd = bf.end_cp;
                baseText = (0, util_1.sliceCp)(bln.content, bf.start_cp, bf.end_cp);
            }
        }
    }
    if (j.decided && chosenMsId != null) {
        const cf = nfs.find((x) => x.ms_id === chosenMsId && !x.missing);
        const cln = cf?.line_id != null ? linesById.get(cf.line_id) : undefined;
        if (cf && cln && cf.start_cp != null && cf.end_cp != null && cln.ms_id === chosenMsId) {
            chosenLineId = cf.line_id ?? null;
            chosenLineNo = cln.line_no;
            chosenStart = cf.start_cp;
            chosenEnd = cf.end_cp;
        }
    }
    await client.query(`UPDATE group_judgments
       SET group_id=$1, last_ord=$2,
           base_ms_id=$3, base_line_no=$4, base_start_cp=$5, base_end_cp=$6, base_text=$7,
           chosen_line_id=$8, chosen_line_no=$9, chosen_start_cp=$10, chosen_end_cp=$11,
           updated_at=now()
     WHERE id=$12`, [
        newGroupId, newOrd,
        baseMsId, baseLineNo, baseStart, baseEnd, baseText,
        chosenLineId, chosenLineNo, chosenStart, chosenEnd,
        j.id,
    ]);
}
async function detachOrphan(client, j, reason) {
    await client.query(`UPDATE group_judgments
       SET group_id=NULL, chosen_line_id=NULL, needs_review=TRUE, review_reason=$1, updated_at=now()
     WHERE id=$2`, [reason, j.id]);
}
// ---- 读模型装配 ----
function toJudgmentView(j, msNameById, lastOrd) {
    const status = j.needs_review
        ? 'review'
        : j.decided
            ? 'confirmed'
            : 'undecided';
    const view = {
        id: j.id,
        status,
        decided: j.decided,
        reason: j.reason,
        quoteText: j.quote_text,
        needsReview: j.needs_review,
        reviewReason: j.needs_review ? j.review_reason || null : null,
        frozen: j.frozen,
        chosenMsId: j.chosen_ms_id,
        chosenMsName: j.chosen_ms_id != null ? msNameById.get(j.chosen_ms_id) ?? null : null,
        chosenLineNo: j.chosen_line_no,
        chosenStartCp: j.chosen_start_cp,
        chosenEndCp: j.chosen_end_cp,
        baseMsId: j.base_ms_id,
        baseMsName: j.base_ms_id != null ? msNameById.get(j.base_ms_id) ?? null : null,
        baseLineNo: j.base_line_no,
        baseStartCp: j.base_start_cp,
        baseEndCp: j.base_end_cp,
        baseText: j.base_text,
        createdAt: j.created_at instanceof Date ? j.created_at.toISOString() : String(j.created_at ?? ''),
        updatedAt: j.updated_at instanceof Date ? j.updated_at.toISOString() : String(j.updated_at ?? ''),
    };
    if (lastOrd !== undefined)
        view.lastOrd = lastOrd;
    return view;
}
/** 把判读意见装配进 CollationView（groups[].judgment + orphanJudgments + stats）。 */
async function attachJudgmentsToView(client, docId, groups, manuscripts) {
    const { rows } = await client.query('SELECT * FROM group_judgments WHERE doc_id=$1 ORDER BY id', [docId]);
    const msNameById = new Map(manuscripts.map((m) => [m.id, m.name]));
    const byGroup = new Map();
    const orphans = [];
    for (const j of rows) {
        if (j.group_id != null)
            byGroup.set(j.group_id, j);
        else
            orphans.push(j);
    }
    for (const gv of groups) {
        const j = byGroup.get(gv.id);
        gv.judgment = j ? toJudgmentView(j, msNameById) : null;
    }
    const orphanViews = orphans.map((j) => {
        const v = toJudgmentView(j, msNameById, j.last_ord ?? null);
        v.lastOrd = j.last_ord ?? null;
        return v;
    });
    let confirmed = 0;
    let undecided = 0;
    let review = 0;
    for (const j of rows) {
        if (j.needs_review)
            review++;
        else if (j.decided)
            confirmed++;
        else
            undecided++;
    }
    return { orphans: orphanViews, confirmed, undecided, review };
}
// ---- 切底本：组锚点的底本引用切到新底本；不含新底本有效片段的组 → 待复核 ----
/**
 * 底本切换后处理判读意见：
 *  - 组在新底本下完好且有有效底本片段：把底本锚点刷新为新底本片段位置 / 文字；
 *  - 组待修复 / 缺新底本片段 / 引用失效 / 越界：置待复核闩锁（底本改变后须人重新确认）；
 *  - 不静默改变已裁定意见的“所选抄本 / 引用文字”。
 * 调用方须已把不含新底本真实片段的组置为 broken。
 */
async function retargetJudgmentsForBaseSwitch(client, docId, newBaseMsId) {
    const { rows: jrows } = await client.query('SELECT id, group_id FROM group_judgments WHERE doc_id=$1 FOR UPDATE', [docId]);
    for (const jrow of jrows) {
        if (jrow.group_id == null)
            continue;
        const gres = await client.query('SELECT ord, broken FROM grp WHERE id=$1', [jrow.group_id]);
        const g = gres.rows[0];
        if (!g || g.broken) {
            await client.query(`UPDATE group_judgments
           SET needs_review=TRUE, review_reason=$1, base_ms_id=$2, updated_at=now()
         WHERE id=$3`, [`第 ${g?.ord ?? '?'} 组在切换底本后待修复：请按新底本重新确认判读意见`, newBaseMsId, jrow.id]);
            continue;
        }
        const bfRes = await client.query('SELECT line_id, start_cp, end_cp FROM fragments WHERE group_id=$1 AND ms_id=$2 AND missing=FALSE', [jrow.group_id, newBaseMsId]);
        const bfr = bfRes.rows[0];
        if (!bfr || bfr.line_id == null || bfr.start_cp == null || bfr.end_cp == null) {
            await client.query(`UPDATE group_judgments
           SET needs_review=TRUE, review_reason=$1, base_ms_id=$2, updated_at=now()
         WHERE id=$3`, [`第 ${g.ord} 组在切换底本后缺少新底本片段：请重新确认判读意见`, newBaseMsId, jrow.id]);
            continue;
        }
        const lr = await client.query('SELECT line_no, content, ms_id FROM lines WHERE id=$1', [bfr.line_id]);
        const ln = lr.rows[0];
        if (!ln || ln.ms_id !== newBaseMsId) {
            await client.query(`UPDATE group_judgments
           SET needs_review=TRUE, review_reason=$1, base_ms_id=$2, updated_at=now()
         WHERE id=$3`, [`第 ${g.ord} 组新底本片段引用失效：请重新确认判读意见`, newBaseMsId, jrow.id]);
            continue;
        }
        const len = (0, util_1.charLen)(ln.content);
        if (bfr.start_cp < 0 || bfr.end_cp <= bfr.start_cp || bfr.end_cp > len) {
            await client.query(`UPDATE group_judgments
           SET needs_review=TRUE, review_reason=$1, base_ms_id=$2, updated_at=now()
         WHERE id=$3`, [`第 ${g.ord} 组新底本片段越界：请重新确认判读意见`, newBaseMsId, jrow.id]);
            continue;
        }
        await client.query(`UPDATE group_judgments
         SET base_ms_id=$1, base_line_no=$2, base_start_cp=$3, base_end_cp=$4,
             base_text=$5, updated_at=now()
       WHERE id=$6`, [
            newBaseMsId,
            ln.line_no,
            bfr.start_cp,
            bfr.end_cp,
            (0, util_1.sliceCp)(ln.content, bfr.start_cp, bfr.end_cp),
            jrow.id,
        ]);
    }
}
// ---- 重新确认（待复核 → 有效）：人在当前工作版重新核对引用后调用 ----
/**
 * 在当前组数据上重新核对一条意见：
 *  - 已裁定：必须仍能挂在某完好组上、所选抄本有有效片段且引用文字与存储一致；
 *  - 未裁定：必须挂在某完好组上。
 * 成功：清除待复核闩锁、解冻、刷新锚点。无法确认 → 返回中文原因（调用方抛 409）。
 * 对孤儿意见，attachGroupId 可显式指定要重新挂到的组（由人选定）；不给则按锚点自动唯一配对。
 */
async function reconfirmJudgment(client, docId, judgmentId, opts = {}) {
    const { rows: jr } = await client.query('SELECT * FROM group_judgments WHERE id=$1 AND doc_id=$2 FOR UPDATE', [judgmentId, docId]);
    if (jr.length === 0) {
        throw new util_1.HttpError(404, `判读意见 #${judgmentId} 不存在`);
    }
    const j = jr[0];
    const data = await loadGroupData(client, docId, true);
    const groupById = new Map(data.groups.map((g) => [g.id, g]));
    const fragsByGroup = new Map();
    for (const f of data.fragments) {
        const arr = fragsByGroup.get(f.group_id) ?? [];
        arr.push(f);
        fragsByGroup.set(f.group_id, arr);
    }
    const linesById = new Map(data.lines.map((l) => [l.id, l]));
    const { rows: mss } = await client.query('SELECT id, name FROM manuscripts WHERE doc_id=$1 ORDER BY position, id', [docId]);
    const msNameById = new Map(mss.map((m) => [m.id, m.name]));
    const msIds = new Set(mss.map((m) => m.id));
    let targetGroupId = null;
    if (opts.attachGroupId != null) {
        if (!groupById.has(opts.attachGroupId)) {
            throw new Error(`对应组 #${opts.attachGroupId} 不存在`);
        }
        targetGroupId = opts.attachGroupId;
    }
    else if (j.group_id != null && groupById.has(j.group_id)) {
        targetGroupId = j.group_id;
    }
    else {
        // 孤儿意见：按底本锚点在当前组中做唯一配对
        if (j.base_ms_id != null &&
            j.base_line_no != null &&
            j.base_start_cp != null &&
            j.base_end_cp != null) {
            const key = locKey(j.base_ms_id, j.base_line_no, j.base_start_cp, j.base_end_cp);
            const idx = buildBaseLocationIndex(data.groups, data.fragments, linesById, j.base_ms_id);
            const hits = idx.get(key) ?? [];
            if (hits.length === 1)
                targetGroupId = hits[0];
        }
    }
    if (targetGroupId == null) {
        throw new Error('原组与引用位置在当前工作版无法唯一对应，无法自动重新确认；请撤回后重新判读');
    }
    const g = groupById.get(targetGroupId);
    if (g.broken)
        throw new Error(`第 ${g.ord} 组仍待修复，请先修复该组再确认意见`);
    const fs = fragsByGroup.get(targetGroupId) ?? [];
    if (!j.decided) {
        await client.query(`UPDATE group_judgments
         SET group_id=$1, last_ord=$2, needs_review=FALSE, review_reason='', frozen=FALSE, updated_at=now()
       WHERE id=$3`, [targetGroupId, g.ord, j.id]);
        return { groupId: targetGroupId, ord: g.ord };
    }
    // 已裁定：所选抄本须仍在本组有有效片段、引用文字须与存储一致
    if (j.chosen_ms_id == null || !msIds.has(j.chosen_ms_id)) {
        throw new Error('意见所选抄本已不存在，无法重新确认；请撤回后重新判读');
    }
    const chosen = cellState(g, fs, linesById, j.chosen_ms_id);
    const chosenName = msNameById.get(j.chosen_ms_id) ?? null;
    if (!chosen.ok) {
        throw new Error(`第 ${g.ord} 组中所选抄本${chosenName ? `「${chosenName}」` : ''}当前无有效片段（缺文 / 失效），无法确认引用；请撤回后重新判读`);
    }
    if ((chosen.cell.text ?? '') !== j.quote_text) {
        throw new Error(`第 ${g.ord} 组${chosenName ? `「${chosenName}」` : ''}引用文字与当前片段不一致（存储引用「${j.quote_text}」≠ 当前「${chosen.cell.text ?? ''}」），无法确认；请撤回后重新判读`);
    }
    // 底本锚点也须与当前组一致（人确认的就是这个组）
    if (j.base_ms_id != null) {
        const base = cellState(g, fs, linesById, j.base_ms_id);
        if (!base.ok)
            throw new Error(`第 ${g.ord} 组底本片段当前无效，无法确认；请先修复该组`);
    }
    await attachToGroup(client, j, targetGroupId, g.ord, fs, linesById, j.base_ms_id, j.chosen_ms_id);
    await client.query('UPDATE group_judgments SET needs_review=FALSE, review_reason=\'\', frozen=FALSE, updated_at=now() WHERE id=$1', [j.id]);
    return { groupId: targetGroupId, ord: g.ord };
}
// ---- 已发布版恢复 / 归档导入：以快照（CollationView.groups[].judgment）整体重建意见 ----
/**
 * 以一份已发布快照中固化的判读意见整体替换当前工作版意见（恢复已发布版时调用）：
 *  - 先删除本文献全部现有意见；
 *  - 快照中的意见按“底本片段位置（抄本+行号+码点）”在恢复后的工作版组中唯一配对挂载；
 *  - 恢复后的组与快照同构（buildRestorePlan 已校验），故正常快照必能一一对应；
 *  - 恢复带回的意见标记 frozen=TRUE：已裁定 / 未裁定保持其当时发布状态（可随该版再次发布）；
 *    快照中若存在待复核意见（理论上发布门禁已阻止，防御性处理）则保留为待复核孤儿 / 挂组意见。
 */
async function syncJudgmentsFromSnapshot(client, docId, snapshot) {
    await client.query('DELETE FROM group_judgments WHERE doc_id=$1', [docId]);
    const snapGroups = snapshot?.groups ?? [];
    if (!Array.isArray(snapGroups))
        return { restored: 0, review: 0 };
    // 恢复后的当前工作版：组 / 片段 / 行
    const data = await loadGroupData(client, docId, false);
    const linesById = new Map(data.lines.map((l) => [l.id, l]));
    const groupById = new Map(data.groups.map((g) => [g.id, g]));
    const fragsByGroup = new Map();
    for (const f of data.fragments) {
        const arr = fragsByGroup.get(f.group_id) ?? [];
        arr.push(f);
        fragsByGroup.set(f.group_id, arr);
    }
    const { rows: mss } = await client.query('SELECT id FROM manuscripts WHERE doc_id=$1', [docId]);
    const msIds = new Set(mss.map((m) => m.id));
    const newIndex = buildBaseLocationIndex(data.groups, data.fragments, linesById, snapshot.document?.baseMsId ?? null);
    let restored = 0;
    let review = 0;
    for (const sg of snapGroups) {
        const sv = sg.judgment;
        if (!sv)
            continue;
        const needsReview = sv.needsReview === true || sv.status === 'review';
        // 以快照组的底本片段当前坐标（snapshot 的 GroupView.cells）构造锚点
        const baseMsId = sv.baseMsId ?? snapshot.document?.baseMsId ?? null;
        const baseLineNo = sv.baseLineNo;
        const baseStartCp = sv.baseStartCp;
        const baseEndCp = sv.baseEndCp;
        const baseText = sv.baseText ?? '';
        let attachGroupId = null;
        if (baseMsId != null && baseLineNo != null && baseStartCp != null && baseEndCp != null && !needsReview) {
            const hits = newIndex.get(locKey(baseMsId, baseLineNo, baseStartCp, baseEndCp)) ?? [];
            if (hits.length === 1)
                attachGroupId = hits[0];
        }
        const ng = attachGroupId != null ? groupById.get(attachGroupId) : undefined;
        // 解析所选片段锚点（由快照 msId / lineNo / 区间 → 当前行 id）
        let chosenLineId = null;
        if (sv.decided && sv.chosenMsId != null && sv.chosenLineNo != null && attachGroupId != null) {
            const cf = (fragsByGroup.get(attachGroupId) ?? []).find((f) => f.ms_id === sv.chosenMsId && !f.missing);
            const cln = cf?.line_id != null ? linesById.get(cf.line_id) : undefined;
            if (cln && cln.line_no === sv.chosenLineNo)
                chosenLineId = cln.id;
        }
        const isReview = needsReview || attachGroupId == null;
        if (isReview)
            review++;
        restored++;
        await client.query(`INSERT INTO group_judgments
         (doc_id, group_id, chosen_ms_id, chosen_line_id, decided, reason, quote_text,
          base_ms_id, base_line_no, base_start_cp, base_end_cp, base_text,
          chosen_line_no, chosen_start_cp, chosen_end_cp,
          needs_review, review_reason, frozen, last_ord)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,TRUE,$18)`, [
            docId,
            isReview ? null : attachGroupId,
            sv.decided && sv.chosenMsId != null && msIds.has(sv.chosenMsId) ? sv.chosenMsId : null,
            isReview ? null : chosenLineId,
            sv.decided === true,
            typeof sv.reason === 'string' ? sv.reason : '',
            typeof sv.quoteText === 'string' ? sv.quoteText : '',
            baseMsId,
            baseLineNo,
            baseStartCp,
            baseEndCp,
            baseText,
            sv.chosenLineNo ?? null,
            sv.chosenStartCp ?? null,
            sv.chosenEndCp ?? null,
            isReview,
            typeof sv.reviewReason === 'string' && isReview ? sv.reviewReason : isReview ? '随恢复带回的待复核意见，请重新确认或撤回' : '',
            ng?.ord ?? sg.ord ?? null,
        ]);
    }
    return { restored, review };
}
