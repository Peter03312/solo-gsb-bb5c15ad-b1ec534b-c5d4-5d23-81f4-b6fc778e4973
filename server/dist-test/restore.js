"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildRestorePlan = buildRestorePlan;
exports.applyRestore = applyRestore;
const util_1 = require("./util");
const validate_1 = require("./validate");
function invalidSnapshot(message, issues) {
    throw new util_1.HttpError(409, `第版快照内容无法构成合法归组：${message}；已整体拒绝、未改动任何数据`, { code: 'RESTORE_SNAPSHOT_INVALID', issues });
}
/**
 * 解析并校验快照，产出恢复计划。纯函数（不碰数据库）：
 * 先做结构校验，再以「快照抄本 + 快照原始行」为上下文复用与整批保存完全一致的
 * 归组规则校验（每组恰一个底本片段 / 每抄本每组至多一片 / 不行内重叠 / 不越界 / 组序连续）。
 */
function buildRestorePlan(snapshot) {
    const issues = [];
    const v = snapshot;
    if (!v || typeof v !== 'object') {
        invalidSnapshot('快照不是合法对象', [{ code: 'SNAPSHOT_SHAPE', message: '快照根节点必须是对象' }]);
    }
    const snap = v;
    // ---- 1. 抄本及顺序 ----
    if (!Array.isArray(snap.manuscripts) || snap.manuscripts.length === 0) {
        issues.push({ code: 'SNAPSHOT_SHAPE', message: '快照缺少抄本列表（manuscripts）' });
    }
    const manuscripts = [];
    const msNames = new Map();
    if (Array.isArray(snap.manuscripts)) {
        const seenIds = new Set();
        const seenPos = new Set();
        snap.manuscripts.forEach((m, i) => {
            if (!m || !(0, util_1.isInt)(m.id) || m.id <= 0) {
                issues.push({ code: 'SNAPSHOT_SHAPE', message: `第 ${i + 1} 份抄本缺少合法 id` });
                return;
            }
            if (seenIds.has(m.id)) {
                issues.push({ code: 'SNAPSHOT_SHAPE', message: `抄本 id ${m.id} 在快照中重复` });
                return;
            }
            seenIds.add(m.id);
            if (typeof m.name !== 'string' || !m.name.trim()) {
                issues.push({ code: 'SNAPSHOT_SHAPE', message: `抄本 #${m.id} 缺少名称`, msName: `抄本#${m.id}` });
            }
            if (!(0, util_1.isInt)(m.position) || m.position <= 0) {
                issues.push({ code: 'SNAPSHOT_SHAPE', message: `抄本「${m.name ?? m.id}」缺少合法顺序 position` });
            }
            else if (seenPos.has(m.position)) {
                issues.push({ code: 'SNAPSHOT_SHAPE', message: `抄本顺序 position=${m.position} 重复` });
            }
            else {
                seenPos.add(m.position);
            }
            manuscripts.push({ id: m.id, name: typeof m.name === 'string' ? m.name : `抄本#${m.id}`, position: m.position });
            msNames.set(m.id, typeof m.name === 'string' ? m.name : `抄本#${m.id}`);
        });
        // 顺序必须恰好为 1..n（恢复“抄本及顺序”）
        const positions = manuscripts.map((m) => m.position).filter((p) => (0, util_1.isInt)(p) && p > 0).sort((a, b) => a - b);
        if (issues.length === 0 && positions.some((p, i) => p !== i + 1)) {
            issues.push({ code: 'SNAPSHOT_SHAPE', message: '快照抄本顺序不连续（position 应为自 1 起的连续编号）' });
        }
    }
    const msIds = new Set(manuscripts.map((m) => m.id));
    const msName = (id) => msNames.get(id) ?? `抄本#${id}`;
    // ---- 2. 底本 ----
    if (!(0, util_1.isInt)(snap.document?.baseMsId) || !msIds.has(snap.document.baseMsId)) {
        issues.push({
            code: 'SNAPSHOT_SHAPE',
            message: `快照底本 id=${snap.document?.baseMsId} 不在快照抄本中`,
        });
    }
    const baseMsId = snap.document?.baseMsId;
    // ---- 3. 原始行（按 抄本 + 行号 建索引）----
    const lines = [];
    /** (msId,lineNo) → 伪行 id（负整数，绝不与任何真实行 id 混淆） */
    const pseudoLineId = new Map();
    /** (msId,lineNo) → 行内容 */
    const lineContent = new Map();
    if (!Array.isArray(snap.rawByMs)) {
        issues.push({ code: 'SNAPSHOT_SHAPE', message: '快照缺少原始行文（rawByMs）' });
    }
    else {
        const seenRawMs = new Set();
        for (const raw of snap.rawByMs) {
            if (!raw || !(0, util_1.isInt)(raw.msId) || !msIds.has(raw.msId)) {
                issues.push({ code: 'SNAPSHOT_SHAPE', message: 'rawByMs 中存在不属于快照抄本的行文条目' });
                continue;
            }
            if (seenRawMs.has(raw.msId)) {
                issues.push({ code: 'SNAPSHOT_SHAPE', message: `抄本「${msName(raw.msId)}」的行文条目重复`, msName: msName(raw.msId) });
                continue;
            }
            seenRawMs.add(raw.msId);
            if (!Array.isArray(raw.lines)) {
                issues.push({ code: 'SNAPSHOT_SHAPE', message: `抄本「${msName(raw.msId)}」缺少行列表`, msName: msName(raw.msId) });
                continue;
            }
            const seenNo = new Set();
            raw.lines.forEach((ln, i) => {
                if (!ln || !(0, util_1.isInt)(ln.lineNo) || ln.lineNo <= 0) {
                    issues.push({ code: 'SNAPSHOT_SHAPE', message: `抄本「${msName(raw.msId)}」第 ${i + 1} 行缺少合法行号`, msName: msName(raw.msId) });
                    return;
                }
                if (typeof ln.content !== 'string') {
                    issues.push({ code: 'SNAPSHOT_SHAPE', message: `抄本「${msName(raw.msId)}」第 ${ln.lineNo} 行缺少文字`, msName: msName(raw.msId), lineNo: ln.lineNo });
                    return;
                }
                if (seenNo.has(ln.lineNo)) {
                    issues.push({ code: 'SNAPSHOT_SHAPE', message: `抄本「${msName(raw.msId)}」行号 ${ln.lineNo} 重复`, msName: msName(raw.msId), lineNo: ln.lineNo });
                    return;
                }
                seenNo.add(ln.lineNo);
                lines.push({ msId: raw.msId, lineNo: ln.lineNo, content: ln.content });
            });
        }
        // 每抄本行号必须自 1 连续
        for (const msId of msIds) {
            const nos = lines.filter((l) => l.msId === msId).map((l) => l.lineNo).sort((a, b) => a - b);
            if (nos.some((no, i) => no !== i + 1)) {
                issues.push({ code: 'SNAPSHOT_SHAPE', message: `抄本「${msName(msId)}」原始行号不连续`, msName: msName(msId) });
            }
        }
        lines.forEach((l, i) => {
            const key = `${l.msId}:${l.lineNo}`;
            pseudoLineId.set(key, -(i + 1));
            lineContent.set(key, l.content);
        });
    }
    // ---- 4. 对应组、片段与缺文标记 ----
    const groups = [];
    if (!Array.isArray(snap.groups)) {
        issues.push({ code: 'SNAPSHOT_SHAPE', message: '快照缺少对应组列表（groups）' });
    }
    else if (snap.groups.length === 0) {
        issues.push({ code: 'SNAPSHOT_SHAPE', message: '快照没有任何对应组（已发布校勘版至少含一组）' });
    }
    else {
        const seenOrd = new Set();
        snap.groups.forEach((g, gi) => {
            const ord = (0, util_1.isInt)(g?.ord) ? g.ord : gi + 1;
            if (!g || typeof g !== 'object' || !(0, util_1.isInt)(g.ord) || g.ord < 1) {
                issues.push({ code: 'SNAPSHOT_SHAPE', message: `第 ${gi + 1} 组缺少合法组序 ord` });
                return;
            }
            if (seenOrd.has(g.ord)) {
                issues.push({ code: 'SNAPSHOT_SHAPE', message: `组序 ${g.ord} 在快照中重复`, groupOrd: g.ord });
                return;
            }
            seenOrd.add(g.ord);
            if (!Array.isArray(g.cells) || g.cells.length === 0) {
                issues.push({ code: 'SNAPSHOT_SHAPE', message: `第 ${ord} 组缺少任何抄本单元`, groupOrd: ord });
                return;
            }
            // 已发布快照中的组必须完好：待修复 / 越界片段不构成合法归组
            if (g.broken) {
                issues.push({ code: 'SNAPSHOT_GROUP_BROKEN', message: `第 ${ord} 组在快照中带待修复标记，不构成合法归组`, groupOrd: ord });
            }
            const frags = [];
            const cellMs = new Set();
            for (const c of g.cells) {
                if (!c || !(0, util_1.isInt)(c.msId) || !msIds.has(c.msId)) {
                    issues.push({ code: 'SNAPSHOT_SHAPE', message: `第 ${ord} 组引用了快照中不存在的抄本`, groupOrd: ord });
                    continue;
                }
                if (cellMs.has(c.msId)) {
                    issues.push({ code: 'DUP_MS', message: `第 ${ord} 组中抄本「${msName(c.msId)}」出现多个单元`, groupOrd: ord, msName: msName(c.msId) });
                    continue;
                }
                cellMs.add(c.msId);
                if (c.missing) {
                    frags.push({ msId: c.msId, missing: true, pseudoLineId: null, startCp: null, endCp: null });
                    continue;
                }
                // 无片段单元（absent）：不产生 fragment
                const hasLoc = c.lineNo != null || c.startCp != null || c.endCp != null || c.text != null;
                if (!hasLoc)
                    continue;
                const key = `${c.msId}:${c.lineNo}`;
                const pid = pseudoLineId.get(key);
                const content = lineContent.get(key);
                if (pid == null || content == null) {
                    issues.push({
                        code: 'SNAPSHOT_BAD_LINE',
                        message: `第 ${ord} 组「${msName(c.msId)}」引用了快照中不存在的第 ${c.lineNo} 行`,
                        groupOrd: ord, msName: msName(c.msId), lineNo: c.lineNo ?? undefined,
                    });
                    continue;
                }
                if (!(0, util_1.isInt)(c.startCp) || !(0, util_1.isInt)(c.endCp) || c.startCp < 0 || c.endCp <= c.startCp) {
                    issues.push({
                        code: 'SNAPSHOT_BAD_RANGE',
                        message: `第 ${ord} 组「${msName(c.msId)}」片段区间非法 [${c.startCp}, ${c.endCp})`,
                        groupOrd: ord, msName: msName(c.msId), lineNo: c.lineNo ?? undefined,
                    });
                    continue;
                }
                if (c.broken || c.oobEnd != null) {
                    issues.push({
                        code: 'SNAPSHOT_FRAGMENT_BROKEN',
                        message: `第 ${ord} 组「${msName(c.msId)}」片段在快照中越界 / 待修复，不构成合法归组`,
                        groupOrd: ord, msName: msName(c.msId), lineNo: c.lineNo ?? undefined,
                    });
                    continue;
                }
                const len = (0, util_1.charLen)(content);
                if (c.endCp > len) {
                    issues.push({
                        code: 'SNAPSHOT_OUT_OF_RANGE',
                        message: `第 ${ord} 组「${msName(c.msId)}」片段越界：第 ${c.lineNo} 行共 ${len} 字，区间为 [${c.startCp}, ${c.endCp})`,
                        groupOrd: ord, msName: msName(c.msId), lineNo: c.lineNo ?? undefined,
                    });
                    continue;
                }
                // 快照文字必须与其区间截取一致（防止半损坏快照恢复出与快照呈现不符的结果）
                const expectText = (0, util_1.sliceCp)(content, c.startCp, c.endCp);
                if (typeof c.text !== 'string' || c.text !== expectText) {
                    issues.push({
                        code: 'SNAPSHOT_TEXT_MISMATCH',
                        message: `第 ${ord} 组「${msName(c.msId)}」第 ${c.lineNo} 行片段文字与该行原文区间不一致（快照文字「${c.text ?? ''}」≠ 区间文字「${expectText}」）`,
                        groupOrd: ord, msName: msName(c.msId), lineNo: c.lineNo ?? undefined,
                    });
                    continue;
                }
                frags.push({ msId: c.msId, missing: false, pseudoLineId: pid, startCp: c.startCp, endCp: c.endCp });
            }
            groups.push({ ord, fragments: frags });
        });
        // 组序必须自 1 连续
        const ords = groups.map((g) => g.ord).sort((a, b) => a - b);
        if (issues.length === 0 && ords.some((o, i) => o !== i + 1)) {
            issues.push({ code: 'SNAPSHOT_DUP_ORD', message: '快照组序 ord 必须自 1 起连续' });
        }
        // ---- 5. 复用与「整批保存对应组」完全一致的归组规则（底本唯一 / 重叠 / 越界 / 每组每抄本至多一片）----
        if (issues.length === 0) {
            const syntheticGroups = groups.map((g) => ({
                ord: g.ord,
                fragments: g.fragments.map((f) => f.missing
                    ? { msId: f.msId, missing: true }
                    : { msId: f.msId, missing: false, lineId: f.pseudoLineId, startCp: f.startCp, endCp: f.endCp }),
            }));
            try {
                (0, validate_1.validateGroups)(syntheticGroups, {
                    baseMsId,
                    manuscripts: manuscripts.map((m) => ({ id: m.id, doc_id: 0, name: m.name, position: m.position })),
                    lines: lines.map((l, i) => ({
                        id: pseudoLineId.get(`${l.msId}:${l.lineNo}`) ?? -(i + 1),
                        ms_id: l.msId,
                        line_no: l.lineNo,
                        content: l.content,
                    })),
                });
            }
            catch (e) {
                if (e instanceof util_1.HttpError && Array.isArray(e.details)) {
                    for (const d of e.details) {
                        issues.push({
                            code: String(d.code ?? 'ILLEGAL_GROUPING'),
                            message: String(d.message ?? '归组规则校验未通过'),
                            groupOrd: (0, util_1.isInt)(d.groupOrd) ? d.groupOrd : undefined,
                            msName: typeof d.msName === 'string' ? d.msName : undefined,
                            lineNo: (0, util_1.isInt)(d.lineNo) ? d.lineNo : undefined,
                        });
                    }
                }
                else {
                    throw e;
                }
            }
        }
    }
    if (issues.length > 0) {
        invalidSnapshot(`共 ${issues.length} 处问题`, issues);
    }
    let fragmentCount = 0;
    let missingCount = 0;
    for (const g of groups) {
        fragmentCount += g.fragments.length;
        missingCount += g.fragments.filter((f) => f.missing).length;
    }
    return {
        baseMsId,
        manuscripts,
        lines,
        groups,
        stats: {
            manuscriptCount: manuscripts.length,
            lineCount: lines.length,
            groupCount: groups.length,
            fragmentCount,
            missingCount,
        },
    };
}
/**
 * 在已加锁、已通过版本检查的事务内执行恢复（整体替换，绝不部分写入）：
 *  1) 删除全部现有组 / 片段（grp 级联 fragments）与现有原始行；
 *  2) 抄本按快照对齐（沿用现存 id、补入快照中缺失的 id、删除快照外的后增抄本，名称与顺序以快照为准）；
 *  3) 底本切回快照底本；
 *  4) 行与组全部重建，取得当前有效标识；片段 / 缺文按快照落位。
 * 文献标题、published_ver 与 editions 表（全部快照）不在此函数中改动。
 */
async function applyRestore(client, docId, plan) {
    // 1) 清空工作版组 / 片段 / 行（fragments 随 grp 级联；lines 先行删除以解除引用）
    await client.query('DELETE FROM grp WHERE doc_id=$1', [docId]);
    await client.query('DELETE FROM lines WHERE ms_id IN (SELECT id FROM manuscripts WHERE doc_id=$1)', [docId]);
    // 2) 抄本对齐
    const { rows: existing } = await client.query('SELECT id FROM manuscripts WHERE doc_id=$1', [docId]);
    const snapIds = new Set(plan.manuscripts.map((m) => m.id));
    const extraIds = existing.map((r) => r.id).filter((id) => !snapIds.has(id));
    if (extraIds.length > 0) {
        await client.query('DELETE FROM manuscripts WHERE id = ANY($1::bigint[])', [extraIds]);
    }
    const existingIds = new Set(existing.map((r) => r.id).filter((id) => snapIds.has(id)));
    // 先把现存抄本位移到负位，避免按快照顺序回写时触发 UNIQUE(doc_id, position)
    await client.query('UPDATE manuscripts SET position = -position WHERE doc_id=$1', [docId]);
    let explicitInsert = false;
    for (const m of plan.manuscripts) {
        if (existingIds.has(m.id)) {
            await client.query('UPDATE manuscripts SET name=$1, position=$2 WHERE id=$3', [m.name, m.position, m.id]);
        }
        else {
            explicitInsert = true;
            // 沿用快照抄本身份 id（抄本是跨版本的稳定身份）；行与组不沿用旧 id
            await client.query('INSERT INTO manuscripts (id, doc_id, name, position) VALUES ($1,$2,$3,$4)', [m.id, docId, m.name, m.position]);
        }
    }
    if (explicitInsert) {
        // 显式指定 id 后把序列推到当前最大值之上，保证后续新增抄本取得有效、不冲突的标识
        await client.query(`SELECT pg_catalog.setval(
         pg_catalog.pg_get_serial_sequence('manuscripts', 'id'),
         GREATEST((SELECT COALESCE(MAX(id), 1) FROM manuscripts), 1),
         (SELECT MAX(id) IS NOT NULL FROM manuscripts)
       )`);
    }
    // 3) 底本切回快照底本（标题 / published_ver 保持原样）
    await client.query('UPDATE documents SET base_ms_id=$1 WHERE id=$2', [plan.baseMsId, docId]);
    // 4) 重建原始行（当前有效标识；快照顺序落库）
    const realLineId = new Map(); // 伪行 id → 新行 id
    for (const ms of plan.manuscripts) {
        const msLines = plan.lines
            .filter((l) => l.msId === ms.id)
            .sort((a, b) => a.lineNo - b.lineNo);
        for (const l of msLines) {
            const { rows: ins } = await client.query('INSERT INTO lines (ms_id, line_no, content) VALUES ($1,$2,$3) RETURNING id', [ms.id, l.lineNo, l.content]);
            realLineId.set(pseudoLineIdOf(plan, l.msId, l.lineNo), ins[0].id);
        }
    }
    // 5) 重建对应组（全新组 id；组均完好）与片段 / 缺文标记
    for (const g of plan.groups) {
        const { rows: gr } = await client.query('INSERT INTO grp (doc_id, ord, broken) VALUES ($1,$2,FALSE) RETURNING id', [docId, g.ord]);
        const gid = gr[0].id;
        for (const f of g.fragments) {
            if (f.missing) {
                await client.query('INSERT INTO fragments (group_id, doc_id, ms_id, line_id, start_cp, end_cp, missing) VALUES ($1,$2,$3,NULL,NULL,NULL,TRUE)', [gid, docId, f.msId]);
            }
            else {
                const lineId = realLineId.get(f.pseudoLineId);
                if (lineId == null) {
                    // 理论不可达：buildRestorePlan 已校验每个片段都能映射到快照行
                    throw new util_1.HttpError(500, '恢复失败：片段无法映射到重建后的行');
                }
                await client.query('INSERT INTO fragments (group_id, doc_id, ms_id, line_id, start_cp, end_cp, missing) VALUES ($1,$2,$3,$4,$5,$6,FALSE)', [gid, docId, f.msId, lineId, f.startCp, f.endCp]);
            }
        }
    }
}
function pseudoLineIdOf(plan, msId, lineNo) {
    const idx = plan.lines.findIndex((l) => l.msId === msId && l.lineNo === lineNo);
    return -(idx + 1);
}
