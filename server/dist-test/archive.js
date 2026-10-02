"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ARCHIVE_FORMAT_VERSION = exports.ARCHIVE_FORMAT = void 0;
exports.buildArchive = buildArchive;
exports.validateArchive = validateArchive;
exports.applyArchive = applyArchive;
const util_1 = require("./util");
const validate_1 = require("./validate");
const restore_1 = require("./restore");
/**
 * 文献归档：把一篇文献导出为可迁移归档（含全部已发布版快照），
 * 并把归档导入为另一篇独立文献。
 *
 * 导出：在调用方的 SERIALIZABLE 事务内一次性读取文献全部数据，
 *       归档内容对应同一已提交版本（document.version 即该版本号）。
 *
 * 导入：单次事务内先校验、后写入，任一处不合法即整次回滚：
 *  - 未知格式 / 格式版本不符 → 拒绝；
 *  - 当前完好组按现行归组规则（与整批保存完全一致的 validateGroups）校验；
 *  - 待修复组可保留原有越界坐标，但其真实片段不得有负值、逆序、零长度或悬空引用；
 *  - 每个已发布版快照均须能构成合法归组（复用恢复用的 buildRestorePlan 校验）；
 *  - 全部内部标识（文献 / 抄本 / 行 / 组 / 片段）重建为新 id，
 *    快照内的抄本引用同步重建，历史快照独有（工作版已删除）的抄本
 *    为其保留全新的空闲标识，恢复时可物化而不与任何文献冲突。
 */
exports.ARCHIVE_FORMAT = 'collation-archive';
exports.ARCHIVE_FORMAT_VERSION = 1;
// ---------- 导出 ----------
/** 在同一事务内读取文献全部状态，产出可迁移归档（只读，不推进版本）。 */
async function buildArchive(client, doc) {
    const { rows: mss } = await client.query('SELECT id, name, position FROM manuscripts WHERE doc_id=$1 ORDER BY position, id', [doc.id]);
    const { rows: lines } = await client.query(`SELECT id, ms_id, line_no, content FROM lines
     WHERE ms_id = ANY($1::bigint[]) ORDER BY ms_id, line_no`, [mss.map((m) => m.id)]);
    const { rows: groups } = await client.query('SELECT id, ord, broken FROM grp WHERE doc_id=$1 ORDER BY ord', [doc.id]);
    const { rows: frags } = await client.query(`SELECT id, group_id, ms_id, line_id, start_cp, end_cp, missing
     FROM fragments WHERE doc_id=$1 ORDER BY id`, [doc.id]);
    const { rows: editions } = await client.query('SELECT edition_no, snapshot, created_at FROM editions WHERE doc_id=$1 ORDER BY edition_no', [doc.id]);
    return {
        format: exports.ARCHIVE_FORMAT,
        formatVersion: exports.ARCHIVE_FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        document: {
            title: doc.title,
            version: doc.version,
            publishedVer: doc.published_ver,
            baseMsRef: doc.base_ms_id,
        },
        manuscripts: mss.map((m) => ({ ref: m.id, name: m.name, position: m.position })),
        lines: lines.map((l) => ({ ref: l.id, msRef: l.ms_id, lineNo: l.line_no, content: l.content })),
        groups: groups.map((g) => ({
            ord: g.ord,
            broken: g.broken,
            fragments: frags
                .filter((f) => f.group_id === g.id)
                .map((f) => ({
                msRef: f.ms_id,
                missing: f.missing,
                lineRef: f.missing ? null : f.line_id,
                startCp: f.missing ? null : f.start_cp,
                endCp: f.missing ? null : f.end_cp,
            })),
        })),
        editions: editions.map((e) => ({
            editionNo: e.edition_no,
            createdAt: e.created_at ? new Date(e.created_at).toISOString() : null,
            snapshot: e.snapshot,
        })),
    };
}
function fail(issues) {
    throw new util_1.HttpError(400, `归档校验失败：共 ${issues.length} 处问题，已整次拒绝、未导入任何内容`, { code: 'ARCHIVE_INVALID', issues });
}
/**
 * 校验归档（纯函数，不碰数据库）：
 * 格式与版本 → 结构 → 引用关系 → 完好组归组规则 → 每个发布版快照合法归组。
 * 任何问题都以可定位的 issue（含位置与原因）汇总后一次性抛出 400。
 */
function validateArchive(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        fail([
            {
                code: 'UNKNOWN_FORMAT',
                message: '归档必须是一个 JSON 对象（含 format / formatVersion 等字段）',
                section: 'format',
            },
        ]);
    }
    const a = input;
    if (a.format !== exports.ARCHIVE_FORMAT) {
        fail([
            {
                code: 'UNKNOWN_FORMAT',
                message: `未知归档格式：${JSON.stringify(a.format ?? null)}（应为 "${exports.ARCHIVE_FORMAT}"）`,
                section: 'format',
            },
        ]);
    }
    if (a.formatVersion !== exports.ARCHIVE_FORMAT_VERSION) {
        fail([
            {
                code: 'UNKNOWN_FORMAT_VERSION',
                message: `不支持的归档格式版本：${JSON.stringify(a.formatVersion ?? null)}` +
                    `（当前支持 formatVersion=${exports.ARCHIVE_FORMAT_VERSION}）`,
                section: 'format',
            },
        ]);
    }
    const issues = [];
    // ---- 1. 文献元信息（标题 / 工作版版本号 / 已发布版序号 / 底本引用）----
    const docNode = (a.document ?? {});
    let title = '';
    let version = 0;
    let publishedVer = 0;
    let baseMsRef = null;
    if (typeof docNode.title === 'string' && docNode.title.trim()) {
        title = docNode.title.trim();
    }
    else {
        issues.push({ code: 'BAD_SHAPE', message: 'document.title 缺失或为空', section: 'document' });
    }
    if ((0, util_1.isInt)(docNode.version) && docNode.version > 0) {
        version = docNode.version;
    }
    else {
        issues.push({
            code: 'BAD_SHAPE',
            message: 'document.version 必须是正整数（导出时的工作版版本号）',
            section: 'document',
        });
    }
    if ((0, util_1.isInt)(docNode.publishedVer) && docNode.publishedVer >= 0) {
        publishedVer = docNode.publishedVer;
    }
    else {
        issues.push({
            code: 'BAD_SHAPE',
            message: 'document.publishedVer 必须是非负整数（已发布版序号）',
            section: 'document',
        });
    }
    if ((0, util_1.isInt)(docNode.baseMsRef) && docNode.baseMsRef > 0) {
        baseMsRef = docNode.baseMsRef;
    }
    else {
        issues.push({
            code: 'NO_BASE',
            message: 'document.baseMsRef 缺失或非法：归档必须指明底本抄本引用',
            section: 'document',
        });
    }
    // ---- 2. 抄本及顺序 ----
    const manuscripts = [];
    const msNameByRef = new Map();
    const rawMss = a.manuscripts;
    const mssStructOk = Array.isArray(rawMss) && rawMss.length >= 2;
    if (!Array.isArray(rawMss)) {
        issues.push({ code: 'BAD_SHAPE', message: 'manuscripts 必须是数组（至少两份抄本）', section: 'manuscripts' });
    }
    else if (rawMss.length < 2) {
        issues.push({ code: 'BAD_SHAPE', message: '抄本至少需要两份', section: 'manuscripts' });
    }
    else {
        const seenRef = new Set();
        const seenName = new Set();
        const seenPos = new Set();
        rawMss.forEach((m, i) => {
            if (!m || typeof m !== 'object') {
                issues.push({ code: 'BAD_SHAPE', message: `第 ${i + 1} 份抄本不是对象`, section: 'manuscripts' });
                return;
            }
            const mm = m;
            if (!(0, util_1.isInt)(mm.ref) || mm.ref <= 0) {
                issues.push({ code: 'BAD_SHAPE', message: `第 ${i + 1} 份抄本缺少合法引用 ref（正整数）`, section: 'manuscripts' });
                return;
            }
            if (seenRef.has(mm.ref)) {
                issues.push({ code: 'DUP_MS', message: `抄本引用 ref=${mm.ref} 重复`, section: 'manuscripts' });
                return;
            }
            seenRef.add(mm.ref);
            const name = typeof mm.name === 'string' ? mm.name.trim() : '';
            if (!name) {
                issues.push({ code: 'BAD_SHAPE', message: `抄本 ref=${mm.ref} 缺少名称`, section: 'manuscripts' });
            }
            else if (seenName.has(name)) {
                issues.push({ code: 'DUP_MS', message: `抄本名称「${name}」重复`, section: 'manuscripts', msName: name });
            }
            else {
                seenName.add(name);
            }
            if (!(0, util_1.isInt)(mm.position) || mm.position <= 0) {
                issues.push({ code: 'BAD_POSITION', message: `抄本「${name || mm.ref}」缺少合法顺序 position`, section: 'manuscripts' });
            }
            else if (seenPos.has(mm.position)) {
                issues.push({ code: 'BAD_POSITION', message: `抄本顺序 position=${mm.position} 重复`, section: 'manuscripts' });
            }
            else {
                seenPos.add(mm.position);
            }
            manuscripts.push({ ref: mm.ref, name: name || `抄本#${mm.ref}`, position: mm.position });
            msNameByRef.set(mm.ref, name || `抄本#${mm.ref}`);
        });
        const positions = manuscripts
            .map((m) => m.position)
            .filter((p) => (0, util_1.isInt)(p) && p > 0)
            .sort((x, y) => x - y);
        if (positions.length === manuscripts.length && positions.some((p, i) => p !== i + 1)) {
            issues.push({
                code: 'BAD_POSITION',
                message: '抄本顺序 position 必须为自 1 起的连续编号',
                section: 'manuscripts',
            });
        }
    }
    const msName = (ref) => msNameByRef.get(ref) ?? `抄本#${ref}`;
    // 底本引用必须落在抄本集合内（缺失引用）
    if (baseMsRef != null && mssStructOk && !msNameByRef.has(baseMsRef)) {
        issues.push({
            code: 'NO_BASE',
            message: `底本引用 baseMsRef=${baseMsRef} 不在 manuscripts 中（缺失引用）`,
            section: 'document',
        });
    }
    // ---- 3. 原始行（抄本 + 行序）----
    const lines = [];
    const lineByRef = new Map();
    const rawLines = a.lines;
    const linesStructOk = Array.isArray(rawLines);
    if (!Array.isArray(rawLines)) {
        issues.push({ code: 'BAD_SHAPE', message: 'lines 必须是数组（可为空）', section: 'lines' });
    }
    else {
        const seenRef = new Set();
        rawLines.forEach((l, i) => {
            if (!l || typeof l !== 'object') {
                issues.push({ code: 'BAD_SHAPE', message: `第 ${i + 1} 行不是对象`, section: 'lines' });
                return;
            }
            const ll = l;
            if (!(0, util_1.isInt)(ll.ref) || ll.ref <= 0) {
                issues.push({ code: 'BAD_SHAPE', message: `第 ${i + 1} 行缺少合法引用 ref（正整数）`, section: 'lines' });
                return;
            }
            if (seenRef.has(ll.ref)) {
                issues.push({ code: 'DUP_LINE', message: `行引用 ref=${ll.ref} 重复`, section: 'lines' });
                return;
            }
            seenRef.add(ll.ref);
            if (mssStructOk && (!(0, util_1.isInt)(ll.msRef) || !msNameByRef.has(ll.msRef))) {
                issues.push({
                    code: 'BAD_MS_REF',
                    message: `行 ref=${ll.ref} 引用了归档中不存在的抄本 msRef=${JSON.stringify(ll.msRef ?? null)}（缺失引用）`,
                    section: 'lines',
                });
                return;
            }
            if (!(0, util_1.isInt)(ll.lineNo) || ll.lineNo <= 0) {
                issues.push({ code: 'BAD_SHAPE', message: `行 ref=${ll.ref} 缺少合法行号 lineNo`, section: 'lines' });
                return;
            }
            if (typeof ll.content !== 'string') {
                issues.push({
                    code: 'BAD_SHAPE',
                    message: `抄本「${msName(ll.msRef)}」第 ${ll.lineNo} 行缺少文字 content`,
                    section: 'lines',
                    msName: msName(ll.msRef),
                    lineNo: ll.lineNo,
                });
                return;
            }
            lines.push({ ref: ll.ref, msRef: ll.msRef, lineNo: ll.lineNo, content: ll.content });
            lineByRef.set(ll.ref, { msRef: ll.msRef, lineNo: ll.lineNo, content: ll.content });
        });
        // 每份抄本的行号必须自 1 连续
        if (mssStructOk) {
            for (const ref of msNameByRef.keys()) {
                const nos = lines
                    .filter((l) => l.msRef === ref)
                    .map((l) => l.lineNo)
                    .sort((x, y) => x - y);
                if (nos.some((no, i) => no !== i + 1)) {
                    issues.push({
                        code: 'LINE_NO_GAP',
                        message: `抄本「${msName(ref)}」原始行号不连续（应自 1 起连续编号）`,
                        section: 'lines',
                        msName: msName(ref),
                    });
                }
            }
        }
    }
    // ---- 4. 对应组：结构 / 引用 / 真实片段坐标下界（完好与待修复组同样不得有负值、逆序、零长度、悬空引用）----
    const groups = [];
    const rawGroups = a.groups;
    if (!Array.isArray(rawGroups)) {
        issues.push({ code: 'BAD_SHAPE', message: 'groups 必须是数组（可为空）', section: 'groups' });
    }
    else {
        const seenOrd = new Set();
        rawGroups.forEach((g, gi) => {
            if (!g || typeof g !== 'object') {
                issues.push({ code: 'BAD_SHAPE', message: `第 ${gi + 1} 组不是对象`, section: 'groups' });
                return;
            }
            const gg = g;
            const ordLabel = (0, util_1.isInt)(gg.ord) ? gg.ord : gi + 1;
            if (!(0, util_1.isInt)(gg.ord) || gg.ord < 1) {
                issues.push({ code: 'BAD_SHAPE', message: `第 ${gi + 1} 组 ord 必须是正整数`, section: 'groups' });
                return;
            }
            if (seenOrd.has(gg.ord)) {
                issues.push({ code: 'DUP_ORD', message: `组序 ${gg.ord} 重复`, section: 'groups', groupOrd: gg.ord });
                return;
            }
            seenOrd.add(gg.ord);
            const broken = gg.broken === true;
            if (!Array.isArray(gg.fragments) || gg.fragments.length === 0) {
                issues.push({
                    code: 'EMPTY_GROUP',
                    message: `第 ${ordLabel} 组没有任何片段（每组至少一条片段或缺文标记）`,
                    section: 'groups',
                    groupOrd: ordLabel,
                });
                return;
            }
            const frags = [];
            const seenMs = new Set();
            for (const f of gg.fragments) {
                if (!f || typeof f !== 'object' || !(0, util_1.isInt)(f.msRef) || (mssStructOk && !msNameByRef.has(f.msRef))) {
                    issues.push({
                        code: 'BAD_MS_REF',
                        message: `第 ${ordLabel} 组引用了归档中不存在的抄本 msRef=${JSON.stringify(f?.msRef ?? null)}（悬空引用）`,
                        section: 'groups',
                        groupOrd: ordLabel,
                    });
                    continue;
                }
                const name = msName(f.msRef);
                if (seenMs.has(f.msRef)) {
                    issues.push({
                        code: 'DUP_MS',
                        message: `第 ${ordLabel} 组中抄本「${name}」出现多个片段（每组每抄本至多一个，缺文也占位）`,
                        section: 'groups',
                        groupOrd: ordLabel,
                        msName: name,
                    });
                    continue;
                }
                seenMs.add(f.msRef);
                if (f.missing === true) {
                    frags.push({ msRef: f.msRef, missing: true, lineRef: null, startCp: null, endCp: null });
                    continue;
                }
                // 真实片段：坐标下界与引用有效性对完好组、待修复组一视同仁
                if (!(0, util_1.isInt)(f.lineRef) || !(0, util_1.isInt)(f.startCp) || !(0, util_1.isInt)(f.endCp)) {
                    issues.push({
                        code: 'BAD_SHAPE',
                        message: `第 ${ordLabel} 组「${name}」的真实片段缺少 lineRef/startCp/endCp（整数）`,
                        section: 'groups',
                        groupOrd: ordLabel,
                        msName: name,
                    });
                    continue;
                }
                const ln = linesStructOk ? lineByRef.get(f.lineRef) : undefined;
                if (linesStructOk && !ln) {
                    issues.push({
                        code: 'BAD_LINE_REF',
                        message: `第 ${ordLabel} 组「${name}」引用了归档中不存在的行 lineRef=${f.lineRef}（悬空引用）`,
                        section: 'groups',
                        groupOrd: ordLabel,
                        msName: name,
                    });
                    continue;
                }
                if (ln && ln.msRef !== f.msRef) {
                    issues.push({
                        code: 'LINE_MS_MISMATCH',
                        message: `第 ${ordLabel} 组「${name}」引用的行 lineRef=${f.lineRef} 属于抄本「${msName(ln.msRef)}」` +
                            `（第 ${ln.lineNo} 行；片段不得引用他抄本的行）`,
                        section: 'groups',
                        groupOrd: ordLabel,
                        msName: name,
                        lineNo: ln.lineNo,
                    });
                    continue;
                }
                if (f.startCp < 0 || f.endCp < 0) {
                    issues.push({
                        code: 'BAD_RANGE',
                        message: `第 ${ordLabel} 组「${name}」片段坐标不得为负值：[${f.startCp}, ${f.endCp})`,
                        section: 'groups',
                        groupOrd: ordLabel,
                        msName: name,
                        lineNo: ln?.lineNo,
                    });
                    continue;
                }
                if (f.endCp < f.startCp) {
                    issues.push({
                        code: 'BAD_RANGE',
                        message: `第 ${ordLabel} 组「${name}」片段区间逆序：[${f.startCp}, ${f.endCp})（需 起 ≤ 止）`,
                        section: 'groups',
                        groupOrd: ordLabel,
                        msName: name,
                        lineNo: ln?.lineNo,
                    });
                    continue;
                }
                if (f.endCp === f.startCp) {
                    issues.push({
                        code: 'BAD_RANGE',
                        message: `第 ${ordLabel} 组「${name}」片段零长度：[${f.startCp}, ${f.endCp})（需 起 < 止）`,
                        section: 'groups',
                        groupOrd: ordLabel,
                        msName: name,
                        lineNo: ln?.lineNo,
                    });
                    continue;
                }
                frags.push({ msRef: f.msRef, missing: false, lineRef: f.lineRef, startCp: f.startCp, endCp: f.endCp });
            }
            groups.push({ ord: ordLabel, broken, fragments: frags });
        });
        // 组序必须自 1 连续
        const ords = groups.map((g) => g.ord).sort((x, y) => x - y);
        if (ords.some((o, i) => o !== i + 1)) {
            issues.push({ code: 'ORD_GAP', message: '组序 ord 必须自 1 起连续编号（底本顺序）', section: 'groups' });
        }
    }
    // ---- 5. 当前完好组：按现行归组规则全量校验（待修复组不参与，其越界坐标允许保留）----
    const intactGroups = groups.filter((g) => !g.broken);
    if (issues.length === 0 && intactGroups.length > 0 && baseMsRef != null) {
        const synthetic = intactGroups.map((g) => ({
            ord: g.ord,
            fragments: g.fragments.map((f) => f.missing
                ? { msId: f.msRef, missing: true }
                : { msId: f.msRef, missing: false, lineId: f.lineRef, startCp: f.startCp, endCp: f.endCp }),
        }));
        try {
            (0, validate_1.validateGroups)(synthetic, {
                baseMsId: baseMsRef,
                manuscripts: manuscripts.map((m) => ({
                    id: m.ref,
                    doc_id: 0,
                    name: m.name,
                    position: m.position,
                })),
                lines: lines.map((l) => ({ id: l.ref, ms_id: l.msRef, line_no: l.lineNo, content: l.content })),
            });
        }
        catch (e) {
            if (e instanceof util_1.HttpError && Array.isArray(e.details)) {
                for (const d of e.details) {
                    issues.push({
                        code: String(d.code ?? 'ILLEGAL_GROUPING'),
                        message: `完好组非法：${String(d.message ?? '归组规则校验未通过')}`,
                        section: 'groups',
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
    // ---- 6. 已发布版快照：编号连续且与 publishedVer 一致；每个快照均须构成合法归组 ----
    const editions = [];
    const rawEditions = a.editions;
    if (!Array.isArray(rawEditions)) {
        issues.push({ code: 'BAD_SHAPE', message: 'editions 必须是数组（可为空）', section: 'editions' });
    }
    else {
        const seenNo = new Set();
        rawEditions.forEach((e, i) => {
            if (!e || typeof e !== 'object') {
                issues.push({ code: 'BAD_SHAPE', message: `第 ${i + 1} 个发布版不是对象`, section: 'editions' });
                return;
            }
            const ee = e;
            if (!(0, util_1.isInt)(ee.editionNo) || ee.editionNo < 1) {
                issues.push({
                    code: 'BAD_SHAPE',
                    message: `第 ${i + 1} 个发布版缺少合法编号 editionNo（正整数）`,
                    section: 'editions',
                });
                return;
            }
            if (seenNo.has(ee.editionNo)) {
                issues.push({
                    code: 'DUP_EDITION',
                    message: `发布版编号 ${ee.editionNo} 重复`,
                    section: 'editions',
                    editionNo: ee.editionNo,
                });
                return;
            }
            seenNo.add(ee.editionNo);
            let createdAt = null;
            if (ee.createdAt != null) {
                if (typeof ee.createdAt === 'string' && !Number.isNaN(Date.parse(ee.createdAt))) {
                    createdAt = ee.createdAt;
                }
                else {
                    issues.push({
                        code: 'BAD_SHAPE',
                        message: `第 ${ee.editionNo} 版 createdAt 非法（应为 ISO 时间串或 null）`,
                        section: 'editions',
                        editionNo: ee.editionNo,
                    });
                    return;
                }
            }
            editions.push({ editionNo: ee.editionNo, createdAt, snapshot: ee.snapshot });
        });
        const nos = editions.map((e) => e.editionNo).sort((x, y) => x - y);
        if (nos.some((n, i) => n !== i + 1)) {
            issues.push({
                code: 'EDITION_NO_GAP',
                message: `发布版编号必须自 1 起连续（实际：${nos.join(', ') || '空'}）`,
                section: 'editions',
            });
        }
        else if (issues.every((it) => it.section !== 'document') && publishedVer !== nos.length) {
            issues.push({
                code: 'PUBLISHED_VER_MISMATCH',
                message: `document.publishedVer=${publishedVer} 与归档内发布版数量 ${nos.length} 不一致`,
                section: 'editions',
            });
        }
        // 快照合法归组校验（与「恢复已发布校勘版」共用同一套校验；快照自包含，独立于工作版数据）
        for (const ed of editions) {
            try {
                (0, restore_1.buildRestorePlan)(ed.snapshot);
            }
            catch (e) {
                if (e instanceof util_1.HttpError) {
                    const sub = e.details?.issues;
                    if (Array.isArray(sub) && sub.length > 0) {
                        for (const s of sub) {
                            issues.push({
                                code: s.code ?? 'SNAPSHOT_INVALID',
                                message: `第 ${ed.editionNo} 版快照：${s.message}`,
                                section: 'editions',
                                editionNo: ed.editionNo,
                                groupOrd: s.groupOrd,
                                msName: s.msName,
                                lineNo: s.lineNo,
                            });
                        }
                    }
                    else {
                        issues.push({
                            code: 'SNAPSHOT_INVALID',
                            message: `第 ${ed.editionNo} 版快照损坏：${e.message}`,
                            section: 'editions',
                            editionNo: ed.editionNo,
                        });
                    }
                }
                else {
                    throw e;
                }
            }
        }
    }
    if (issues.length > 0)
        fail(issues);
    return {
        title,
        version,
        publishedVer,
        baseMsRef: baseMsRef,
        manuscripts,
        lines,
        groups,
        editions,
    };
}
/**
 * 在单次事务内把校验通过的归档写入为一篇全新文献（源文献不被触及）：
 * 文献 / 抄本 / 行 / 组 / 片段全部取得新标识；工作版版本号与已发布版序号
 * 按归档落库；快照内的抄本引用同步重建（历史快照独有的抄本保留全新空闲标识）。
 */
async function applyArchive(client, plan) {
    const { rows: d } = await client.query('INSERT INTO documents (title, version, published_ver) VALUES ($1,$2,$3) RETURNING id', [plan.title, plan.version, plan.publishedVer]);
    const docId = d[0].id;
    // 抄本：重建内部标识（归档 ref → 新 id）
    const msIdMap = new Map();
    for (const m of [...plan.manuscripts].sort((a, b) => a.position - b.position)) {
        const { rows } = await client.query('INSERT INTO manuscripts (doc_id, name, position) VALUES ($1,$2,$3) RETURNING id', [docId, m.name, m.position]);
        msIdMap.set(m.ref, rows[0].id);
    }
    await client.query('UPDATE documents SET base_ms_id=$1 WHERE id=$2', [
        msIdMap.get(plan.baseMsRef),
        docId,
    ]);
    // 原始行（行序不变，全新行 id）
    const lineIdMap = new Map();
    for (const l of plan.lines) {
        const { rows } = await client.query('INSERT INTO lines (ms_id, line_no, content) VALUES ($1,$2,$3) RETURNING id', [msIdMap.get(l.msRef), l.lineNo, l.content]);
        lineIdMap.set(l.ref, rows[0].id);
    }
    // 对应组与片段：待修复状态、缺文标记与（待修复组的）越界坐标原样保留
    let fragmentCount = 0;
    let missingCount = 0;
    for (const g of [...plan.groups].sort((a, b) => a.ord - b.ord)) {
        const { rows } = await client.query('INSERT INTO grp (doc_id, ord, broken) VALUES ($1,$2,$3) RETURNING id', [docId, g.ord, g.broken]);
        const gid = rows[0].id;
        for (const f of g.fragments) {
            fragmentCount++;
            if (f.missing) {
                missingCount++;
                await client.query('INSERT INTO fragments (group_id, doc_id, ms_id, line_id, start_cp, end_cp, missing) VALUES ($1,$2,$3,NULL,NULL,NULL,TRUE)', [gid, docId, msIdMap.get(f.msRef)]);
            }
            else {
                await client.query('INSERT INTO fragments (group_id, doc_id, ms_id, line_id, start_cp, end_cp, missing) VALUES ($1,$2,$3,$4,$5,$6,FALSE)', [gid, docId, msIdMap.get(f.msRef), lineIdMap.get(f.lineRef), f.startCp, f.endCp]);
            }
        }
    }
    // 快照内的抄本引用重建：当前工作版抄本 → 新 id；
    // 仅在历史快照中出现的抄本（工作版已删除）为其保留全新的空闲序列号，
    // 使日后「恢复该版」能把它物化而不与任何文献的抄本冲突。
    const snapMsMap = new Map(msIdMap);
    for (const ed of plan.editions) {
        const snap = ed.snapshot;
        for (const m of snap?.manuscripts ?? []) {
            if ((0, util_1.isInt)(m?.id) && !snapMsMap.has(m.id)) {
                const { rows } = await client.query(`SELECT nextval(pg_get_serial_sequence('manuscripts','id')) AS id`);
                snapMsMap.set(m.id, Number(rows[0].id));
            }
        }
    }
    const mapMs = (old) => snapMsMap.get(old) ?? old;
    for (const ed of plan.editions) {
        const remapped = remapSnapshotMsIds(ed.snapshot, docId, mapMs);
        await client.query(`INSERT INTO editions (doc_id, edition_no, snapshot, created_at)
       VALUES ($1,$2,$3, COALESCE($4::timestamptz, now()))`, [docId, ed.editionNo, JSON.stringify(remapped), ed.createdAt]);
    }
    return {
        documentId: docId,
        title: plan.title,
        version: plan.version,
        publishedVer: plan.publishedVer,
        imported: {
            manuscriptCount: plan.manuscripts.length,
            lineCount: plan.lines.length,
            groupCount: plan.groups.length,
            brokenGroupCount: plan.groups.filter((g) => g.broken).length,
            fragmentCount,
            missingCount,
            editionCount: plan.editions.length,
        },
    };
}
/** 把快照中的文献 id / 底本引用 / 全部抄本引用重建为新文献的标识（其余内容原样保留）。 */
function remapSnapshotMsIds(snapshot, newDocId, mapMs) {
    const v = snapshot;
    if (!v || typeof v !== 'object')
        return snapshot;
    return {
        ...v,
        document: {
            ...v.document,
            id: newDocId,
            baseMsId: v.document?.baseMsId != null ? mapMs(v.document.baseMsId) : null,
        },
        manuscripts: (v.manuscripts ?? []).map((m) => ({ ...m, id: mapMs(m.id) })),
        groups: (v.groups ?? []).map((g) => ({
            ...g,
            cells: (g.cells ?? []).map((c) => ({ ...c, msId: mapMs(c.msId) })),
        })),
        rawByMs: (v.rawByMs ?? []).map((r) => ({ ...r, msId: mapMs(r.msId) })),
    };
}
