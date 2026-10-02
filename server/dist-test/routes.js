"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const db_1 = require("./db");
const collation_1 = require("./collation");
const diff_1 = require("./diff");
const validate_1 = require("./validate");
const supplement_1 = require("./supplement");
const reline_1 = require("./reline");
const batchedit_1 = require("./batchedit");
const restore_1 = require("./restore");
const archive_1 = require("./archive");
const util_1 = require("./util");
const repo_1 = require("./repo");
exports.router = (0, express_1.Router)();
/** 统一异步错误处理 */
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
// ---------- 文献 ----------
exports.router.get('/documents', wrap(async (_req, res) => {
    const { rows } = await (0, db_1.query)(`SELECT d.id, d.title, d.version, d.published_ver,
              d.base_ms_id,
              (SELECT count(*) FROM manuscripts m WHERE m.doc_id=d.id)::int AS ms_count,
              (SELECT count(*) FROM grp g WHERE g.doc_id=d.id AND g.broken)::int AS broken_count
       FROM documents d ORDER BY d.id DESC`);
    res.json({ documents: rows });
}));
exports.router.post('/documents', wrap(async (req, res) => {
    const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim() : null;
    if (!title)
        throw new util_1.HttpError(400, '请填写文献标题');
    const msNames = Array.isArray(req.body.manuscripts)
        ? req.body.manuscripts.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
        : [];
    if (msNames.length < 2)
        throw new util_1.HttpError(400, '至少需要录入两份抄本');
    if (new Set(msNames).size !== msNames.length)
        throw new util_1.HttpError(400, '抄本名称不能重复');
    const result = await (0, db_1.withTx)(async (c) => {
        const { rows: d } = await c.query('INSERT INTO documents (title) VALUES ($1) RETURNING id, version', [title]);
        const docId = d[0].id;
        for (let i = 0; i < msNames.length; i++) {
            await c.query('INSERT INTO manuscripts (doc_id, name, position) VALUES ($1,$2,$3)', [docId, msNames[i], i + 1]);
        }
        // 默认以第一份抄本为底本
        const { rows: m } = await c.query('SELECT id FROM manuscripts WHERE doc_id=$1 ORDER BY position, id LIMIT 1', [docId]);
        await c.query('UPDATE documents SET base_ms_id=$1 WHERE id=$2', [m[0].id, docId]);
        return docId;
    });
    res.status(201).json({ id: result });
}));
exports.router.get('/documents/:id', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const view = await (0, db_1.withTx)(async (c) => (0, collation_1.buildView)(c, await (0, repo_1.getDoc)(c, id)));
    res.json(view);
}));
// ---------- 文献归档（导出 / 导入） ----------
/**
 * 导出可迁移归档（只读，不推进版本）：
 *   GET /api/documents/:id/archive
 * 在单个 SERIALIZABLE 事务内读取文献全部状态，归档对应同一已提交版本
 * （document.version 即该工作版版本号）。内容含：标题、抄本及行序、底本、
 * 当前对应组的片段、缺文与待修复状态、工作版版本号、全部已发布版快照，
 * 并带格式版本（format / formatVersion）。响应带 Content-Disposition 便于直接下载。
 */
exports.router.get('/documents/:id/archive', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const archive = await (0, db_1.withTx)(async (c) => (0, archive_1.buildArchive)(c, await (0, repo_1.getDoc)(c, id)));
    const fallback = `collation-archive-doc${id}-v${archive.document.version}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(`${archive.document.title}-v${archive.document.version}.collation.json`)}`);
    res.json(archive);
}));
/**
 * 导入归档为一篇新文献：
 *   POST /api/documents/import   （请求体即归档 JSON）
 * 单次事务内先校验后写入，任一处不合法即整次回滚（不创建任何文献）：
 * 未知格式 / 缺失引用 / 损坏快照 / 完好组非法区间 → 400，
 * details.code=ARCHIVE_INVALID，details.issues[] 逐条给出位置与原因。
 * 成功 → 201：全部内部标识重建，源文献不受影响；同一文件重复导入各自独立。
 */
exports.router.post('/documents/import', wrap(async (req, res) => {
    const result = await (0, db_1.withTx)(async (c) => {
        const plan = (0, archive_1.validateArchive)(req.body);
        return (0, archive_1.applyArchive)(c, plan);
    });
    res.status(201).json({ ok: true, ...result });
}));
// ---------- 抄本 / 底本 ----------
exports.router.post('/documents/:id/manuscripts', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name)
        throw new util_1.HttpError(400, '请填写抄本名称');
    await (0, db_1.withTx)(async (c) => {
        const doc = await (0, repo_1.lockDoc)(c, id);
        (0, repo_1.checkVersion)(doc, req.body?.expectedVersion);
        const mss = await (0, repo_1.loadMss)(c, id);
        if (mss.some((m) => m.name === name))
            throw new util_1.HttpError(400, '抄本名称不能重复');
        await c.query('INSERT INTO manuscripts (doc_id, name, position) VALUES ($1,$2,$3)', [id, name, mss.length + 1]);
        await (0, repo_1.bumpVersion)(c, id);
    });
    res.status(201).json({ ok: true });
}));
/** 选定底本；切换后不含新底本真实片段的组标为待修复。 */
exports.router.put('/documents/:id/base', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const msId = req.body?.msId;
    if (!(0, util_1.isInt)(msId))
        throw new util_1.HttpError(400, 'msId 必须是整数');
    await (0, db_1.withTx)(async (c) => {
        const doc = await (0, repo_1.lockDoc)(c, id);
        (0, repo_1.checkVersion)(doc, req.body?.expectedVersion);
        const mss = await (0, repo_1.loadMss)(c, id);
        if (!mss.some((m) => m.id === msId))
            throw new util_1.HttpError(400, '该抄本不属于本文献');
        await c.query('UPDATE documents SET base_ms_id=$1 WHERE id=$2', [msId, id]);
        // 没有新底本真实片段的组 → 待修复
        await c.query(`UPDATE grp SET broken=TRUE WHERE doc_id=$1 AND id NOT IN (
           SELECT f.group_id FROM fragments f
           WHERE f.doc_id=$1 AND f.ms_id=$2 AND f.missing=FALSE AND f.line_id IS NOT NULL
         )`, [id, msId]);
        await (0, repo_1.bumpVersion)(c, id);
    });
    res.json({ ok: true });
}));
// ---------- 逐行文字 ----------
exports.router.post('/manuscripts/:msId/lines', wrap(async (req, res) => {
    const msId = Number(req.params.msId);
    const content = typeof req.body?.content === 'string' ? req.body.content : null;
    if (content == null)
        throw new util_1.HttpError(400, '请提供 content（可为空串）');
    await (0, db_1.withTx)(async (c) => {
        const { rows: ms } = await c.query('SELECT id, doc_id FROM manuscripts WHERE id=$1 FOR UPDATE', [msId]);
        if (ms.length === 0)
            throw new util_1.HttpError(404, `抄本 #${msId} 不存在`);
        const doc = await (0, repo_1.lockDoc)(c, ms[0].doc_id);
        (0, repo_1.checkVersion)(doc, req.body?.expectedVersion);
        const { rows: max } = await c.query('SELECT COALESCE(MAX(line_no),0)::int AS n FROM lines WHERE ms_id=$1', [msId]);
        await c.query('INSERT INTO lines (ms_id, line_no, content) VALUES ($1,$2,$3)', [msId, max[0].n + 1, content]);
        await (0, repo_1.bumpVersion)(c, doc.id);
    });
    res.status(201).json({ ok: true });
}));
/**
 * 修改某一行原文（按码点替换 [startCp,endCp) 为 replacement）。
 * 仅使受影响对应组待修复：
 *  - 片段区间与改动区间相交 → 立即待修复（偏移不动，留待研究者修复）；
 *  - 不相交但位于改动点之后 → 整体平移；
 *  - 平移后若越界（缩行）→ 待修复；其余组完好。
 */
exports.router.put('/lines/:lineId', wrap(async (req, res) => {
    const lineId = Number(req.params.lineId);
    const { startCp, endCp, replacement } = req.body ?? {};
    if (!(0, util_1.isInt)(startCp) || !(0, util_1.isInt)(endCp) || typeof replacement !== 'string' || startCp < 0 || endCp < startCp) {
        throw new util_1.HttpError(400, '需要 startCp/endCp（非负整数，起≤止）与 replacement（字符串）');
    }
    await (0, db_1.withTx)(async (c) => {
        const { rows: lr } = await c.query('SELECT id, ms_id, line_no, content FROM lines WHERE id=$1 FOR UPDATE', [lineId]);
        if (lr.length === 0)
            throw new util_1.HttpError(404, `行 #${lineId} 不存在`);
        const line = lr[0];
        const doc = await (0, repo_1.lockDoc)(c, (await c.query('SELECT doc_id FROM manuscripts WHERE id=$1', [line.ms_id])).rows[0].doc_id);
        (0, repo_1.checkVersion)(doc, req.body?.expectedVersion);
        const oldLen = (0, util_1.charLen)(line.content);
        if (startCp > oldLen || endCp > oldLen) {
            throw new util_1.HttpError(400, `替换区间越界：该行共 ${oldLen} 字`, {
                lineNo: line.line_no,
                lineLength: oldLen,
            });
        }
        const newContent = (0, util_1.sliceCp)(line.content, 0, startCp) + replacement + (0, util_1.sliceCp)(line.content, endCp, oldLen);
        const delta = (0, util_1.charLen)(replacement) - (endCp - startCp);
        const { rows: frags } = await c.query(`SELECT f.id, f.group_id, f.start_cp, f.end_cp
         FROM fragments f WHERE f.line_id=$1 AND f.missing=FALSE
         ORDER BY f.start_cp FOR UPDATE OF f`, [lineId]);
        const touchedGroups = new Set();
        for (const f of frags) {
            const intersects = f.start_cp < endCp && startCp < f.end_cp;
            if (intersects) {
                touchedGroups.add(f.group_id); // 偏移保持原样，等修复
            }
            else {
                let ns = f.start_cp;
                let ne = f.end_cp;
                if (f.start_cp >= endCp) {
                    ns += delta;
                    ne += delta;
                }
                // 平移后越界同样待修复
                const newLen = (0, util_1.charLen)(newContent);
                if (ns < 0 || ne <= ns || ns >= newLen || ne > newLen) {
                    touchedGroups.add(f.group_id);
                }
                else {
                    await c.query('UPDATE fragments SET start_cp=$1, end_cp=$2 WHERE id=$3', [ns, ne, f.id]);
                }
            }
        }
        if (touchedGroups.size > 0) {
            await c.query('UPDATE grp SET broken=TRUE WHERE id = ANY($1::bigint[])', [[...touchedGroups]]);
        }
        await c.query('UPDATE lines SET content=$1 WHERE id=$2', [newContent, lineId]);
        await (0, repo_1.bumpVersion)(c, doc.id);
    });
    res.json({ ok: true });
}));
// ---------- 对应组 ----------
/** 整批保存（替换）某文献全部对应组；任一校验失败整体拒绝。 */
exports.router.put('/documents/:id/groups', wrap(async (req, res) => {
    const id = Number(req.params.id);
    await (0, db_1.withTx)(async (c) => {
        const doc = await (0, repo_1.lockDoc)(c, id);
        (0, repo_1.checkVersion)(doc, req.body?.expectedVersion);
        const mss = await (0, repo_1.loadMss)(c, id);
        const lines = await (0, repo_1.loadLines)(c, mss.map((m) => m.id));
        const groups = (0, validate_1.validateGroups)(req.body?.groups, {
            baseMsId: doc.base_ms_id,
            manuscripts: mss,
            lines,
        });
        // ord 连续性
        const ords = groups.map((g) => g.ord).sort((a, b) => a - b);
        if (ords.some((o, i) => o !== i + 1)) {
            throw new util_1.HttpError(400, '组序号 ord 必须从 1 开始连续编号（底本顺序），不能有缺号', {
                ords,
            });
        }
        await c.query('DELETE FROM grp WHERE doc_id=$1', [id]);
        for (const g of groups) {
            const { rows: gr } = await c.query('INSERT INTO grp (doc_id, ord, broken) VALUES ($1,$2,FALSE) RETURNING id', [id, g.ord]);
            const gid = gr[0].id;
            for (const f of g.fragments) {
                await c.query(`INSERT INTO fragments (group_id, doc_id, ms_id, line_id, start_cp, end_cp, missing)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`, [gid, id, f.msId, f.missing ? null : f.lineId, f.missing ? null : f.startCp, f.missing ? null : f.endCp, !!f.missing]);
            }
        }
        await (0, repo_1.bumpVersion)(c, id);
    });
    res.json({ ok: true });
}));
/** 修复单个对应组（整组重录）；与其他组重叠/越界同样精确定位拒绝。 */
exports.router.put('/documents/:id/groups/:groupId/repair', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const groupId = Number(req.params.groupId);
    await (0, db_1.withTx)(async (c) => {
        const doc = await (0, repo_1.lockDoc)(c, id);
        (0, repo_1.checkVersion)(doc, req.body?.expectedVersion);
        const mss = await (0, repo_1.loadMss)(c, id);
        const lines = await (0, repo_1.loadLines)(c, mss.map((m) => m.id));
        const { rows: grow } = await c.query('SELECT id, ord FROM grp WHERE id=$1 AND doc_id=$2 FOR UPDATE', [groupId, id]);
        if (grow.length === 0)
            throw new util_1.HttpError(404, `对应组 #${groupId} 不存在`);
        const candidate = req.body?.group;
        if (!candidate || typeof candidate !== 'object')
            throw new util_1.HttpError(400, '缺少 group');
        // 以“其余组 + 本组”拼成完整集合做全量校验（错误位置一致、规则不重复）
        const { rows: others } = await c.query('SELECT id, ord FROM grp WHERE doc_id=$1 AND id<>$2 ORDER BY ord', [id, groupId]);
        const { rows: ofrags } = await c.query('SELECT id, group_id, ms_id, line_id, start_cp, end_cp, missing FROM fragments WHERE group_id = ANY($1::bigint[])', [others.map((o) => o.id)]);
        const synthetic = others
            .sort((a, b) => a.ord - b.ord)
            .map((o) => ({
            id: o.id,
            ord: o.ord,
            fragments: ofrags
                .filter((f) => f.group_id === o.id)
                .map((f) => ({
                msId: f.ms_id,
                missing: f.missing,
                lineId: f.line_id,
                startCp: f.start_cp,
                endCp: f.end_cp,
            })),
        }));
        synthetic.push({ ...candidate, ord: grow[0].ord });
        synthetic.sort((a, b) => a.ord - b.ord).forEach((g, i) => (g.ord = i + 1));
        (0, validate_1.validateGroups)(synthetic, { baseMsId: doc.base_ms_id, manuscripts: mss, lines });
        await c.query('DELETE FROM fragments WHERE group_id=$1', [groupId]);
        for (const f of candidate.fragments) {
            await c.query(`INSERT INTO fragments (group_id, doc_id, ms_id, line_id, start_cp, end_cp, missing)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`, [groupId, id, f.msId, f.missing ? null : f.lineId, f.missing ? null : f.startCp, f.missing ? null : f.endCp, !!f.missing]);
        }
        await c.query('UPDATE grp SET broken=FALSE WHERE id=$1', [groupId]);
        await (0, repo_1.bumpVersion)(c, id);
    });
    res.json({ ok: true });
}));
/** 删除一个对应组。 */
exports.router.delete('/documents/:id/groups/:groupId', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const groupId = Number(req.params.groupId);
    await (0, db_1.withTx)(async (c) => {
        const doc = await (0, repo_1.lockDoc)(c, id);
        (0, repo_1.checkVersion)(doc, req.body?.expectedVersion);
        const { rows } = await c.query('SELECT 1 FROM grp WHERE id=$1 AND doc_id=$2', [groupId, id]);
        if (rows.length === 0)
            throw new util_1.HttpError(404, `对应组 #${groupId} 不存在`);
        await c.query('DELETE FROM grp WHERE id=$1', [groupId]);
        await (0, repo_1.bumpVersion)(c, id);
    });
    res.json({ ok: true });
}));
// ---------- 补配（按底本文字在目标抄本空闲区间预配片段） ----------
/**
 * 补配预览（只读，不推进版本）：
 * GET /api/documents/:id/supplement/preview?targetMsId=...
 * 仅考虑目标抄本尚无片段且未标缺文的完好组；待修复组不参与。
 */
exports.router.get('/documents/:id/supplement/preview', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const targetMsId = Number(req.query.targetMsId);
    if (!(0, util_1.isInt)(targetMsId) || targetMsId <= 0)
        throw new util_1.HttpError(400, '需要 targetMsId（正整数）指定目标抄本');
    const result = await (0, db_1.withTx)(async (c) => {
        const doc = await (0, repo_1.getDoc)(c, id);
        const mss = await (0, repo_1.loadMss)(c, id);
        if (!mss.some((m) => m.id === targetMsId))
            throw new util_1.HttpError(400, '该抄本不属于本文献');
        if (doc.base_ms_id == null)
            throw new util_1.HttpError(400, '尚未选定底本，无法补配');
        const data = await (0, supplement_1.loadSupplementData)(c, id, doc.base_ms_id, targetMsId);
        return (0, supplement_1.computePreview)(data, id, doc.version, doc.base_ms_id, targetMsId);
    });
    res.json(result);
}));
/**
 * 提交补配：
 * POST /api/documents/:id/supplement { expectedVersion, targetMsId, selections }
 * 以预览时的文献版本号乐观锁；在当前工作版重新核对组、文字、空闲区间及归组规则，
 * 整批通过才写入，保留未选组与已有片段。版本过期 → 409；候选失效 → 409 拒绝整批且不推进版本；
 * 请求体本身非法（含组内多处、候选互相重叠）→ 400。成功后版本只推进一次。
 */
exports.router.post('/documents/:id/supplement', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const targetMsId = req.body?.targetMsId;
    if (!(0, util_1.isInt)(targetMsId) || targetMsId <= 0)
        throw new util_1.HttpError(400, '需要 targetMsId（正整数）指定目标抄本');
    const rawSelections = req.body?.selections;
    if (!Array.isArray(rawSelections) || rawSelections.length === 0) {
        throw new util_1.HttpError(400, 'selections 必须为非空数组（不补配时无需提交）');
    }
    const selections = [];
    const shapeIssues = [];
    rawSelections.forEach((s, i) => {
        if (!s || typeof s !== 'object' || !(0, util_1.isInt)(s.groupId) || !(0, util_1.isInt)(s.msId) ||
            !(0, util_1.isInt)(s.lineId) || !(0, util_1.isInt)(s.startCp) || !(0, util_1.isInt)(s.endCp)) {
            shapeIssues.push({ index: i, message: '每项需含整数 groupId/msId/lineId/startCp/endCp' });
            return;
        }
        if (s.msId !== targetMsId) {
            shapeIssues.push({ index: i, groupOrd: undefined, message: `第 ${i + 1} 项 msId 与目标抄本不一致` });
            return;
        }
        if (s.startCp < 0 || s.endCp <= s.startCp) {
            shapeIssues.push({ index: i, message: `第 ${i + 1} 项区间非法（需 0 ≤ startCp < endCp）` });
            return;
        }
        const dup = selections.some((x) => x.groupId === s.groupId);
        if (dup) {
            shapeIssues.push({ index: i, message: `第 ${i + 1} 项：同一组出现多个候选，每组至多采纳一处` });
            return;
        }
        selections.push({
            groupId: s.groupId,
            msId: s.msId,
            lineId: s.lineId,
            startCp: s.startCp,
            endCp: s.endCp,
        });
    });
    if (shapeIssues.length > 0) {
        throw new util_1.HttpError(400, '补配请求格式有误，未写入任何内容', shapeIssues);
    }
    const result = await (0, db_1.withTx)(async (c) => {
        const doc = await (0, repo_1.lockDoc)(c, id);
        (0, repo_1.checkVersion)(doc, req.body?.expectedVersion); // 版本过期 → 409
        const mss = await (0, repo_1.loadMss)(c, id);
        if (!mss.some((m) => m.id === targetMsId))
            throw new util_1.HttpError(400, '该抄本不属于本文献');
        if (doc.base_ms_id == null)
            throw new util_1.HttpError(400, '尚未选定底本，无法补配');
        const data = await (0, supplement_1.loadSupplementData)(c, id, doc.base_ms_id, targetMsId);
        // 1) 显式重核：组 / 缺文 / 已有片段 / 行归属 / 区间 / 文字 / 空闲 / 候选彼此不重叠
        const issues = (0, supplement_1.recheckSelections)(data, selections, doc.base_ms_id);
        if (issues.length > 0) {
            throw new util_1.HttpError(409, `候选失效：${issues.length} 项在当前工作版核对未通过，已拒绝整批、未写入任何内容，请重新预览`, { code: 'SUPPLEMENT_STALE', currentVersion: doc.version, issues });
        }
        // 2) 归组规则全量核对：以“其余完好组现状 + 采纳后的组”拼成全集，
        //    复用与整批保存完全一致的越界 / 行内重叠 / 每组每抄本至多一片 / 底本唯一校验。
        //    待修复组不参与补配：其（可能越界的）片段不进入全集；新片段与其区间的冲突
        //    已在上一步按“全部现存片段”空闲核对中拒绝。
        const selByGroup = new Map(selections.map((s) => [s.groupId, s]));
        const otherGroups = data.groups.filter((g) => !selByGroup.has(g.id) && !g.broken);
        const synthetic = otherGroups.map((g) => ({
            id: g.id,
            ord: g.ord,
            fragments: data.fragments
                .filter((f) => f.group_id === g.id)
                .map((f) => ({
                msId: f.ms_id,
                missing: f.missing,
                lineId: f.line_id,
                startCp: f.start_cp,
                endCp: f.end_cp,
            })),
        }));
        for (const g of data.groups) {
            const sel = selByGroup.get(g.id);
            if (!sel)
                continue;
            synthetic.push({
                id: g.id,
                ord: g.ord,
                fragments: [
                    ...data.fragments.filter((f) => f.group_id === g.id).map((f) => ({
                        msId: f.ms_id,
                        missing: f.missing,
                        lineId: f.line_id,
                        startCp: f.start_cp,
                        endCp: f.end_cp,
                    })),
                    { msId: sel.msId, missing: false, lineId: sel.lineId, startCp: sel.startCp, endCp: sel.endCp },
                ],
            });
        }
        synthetic.sort((a, b) => a.ord - b.ord);
        const allLines = await (0, repo_1.loadLines)(c, mss.map((m) => m.id));
        (0, validate_1.validateGroups)(synthetic, { baseMsId: doc.base_ms_id, manuscripts: mss, lines: allLines });
        // 3) 整批通过 → 写入片段（保留未选组与已有片段），版本只推进一次
        for (const sel of selections) {
            await c.query(`INSERT INTO fragments (group_id, doc_id, ms_id, line_id, start_cp, end_cp, missing)
           VALUES ($1,$2,$3,$4,$5,$6,FALSE)`, [sel.groupId, id, sel.msId, sel.lineId, sel.startCp, sel.endCp]);
        }
        await (0, repo_1.bumpVersion)(c, id);
        const after = await (0, repo_1.getDoc)(c, id);
        return { applied: selections.length, version: after.version };
    });
    res.status(201).json({ ok: true, ...result });
}));
// ---------- 行界调整（拆分 / 合并原始行，不改变字序） ----------
/**
 * 行界调整预览（只读，不推进版本）：
 *   GET /api/documents/:id/reline/preview?op=split&lineId=&splitCp=
 *   GET /api/documents/:id/reline/preview?op=merge&leftLineId=&rightLineId=
 * 返回调整后的行序、各片段新位置（跨拆分点片段保留原定位并标待修复）、
 * 将处待修复的组，以及提交时须原样带回的 basis 与当前文献版本号。
 * 非法码点位置 / 非相邻行 / 不属于本文献的行 → 400；行不存在 → 404。
 */
exports.router.get('/documents/:id/reline/preview', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const result = await (0, db_1.withTx)(async (c) => {
        const doc = await (0, repo_1.getDoc)(c, id);
        const built = await (0, reline_1.buildReLinePlan)(c, doc, {
            op: req.query.op,
            lineId: req.query.lineId,
            splitCp: req.query.splitCp,
            leftLineId: req.query.leftLineId,
            rightLineId: req.query.rightLineId,
        }, { forUpdate: false, requireBasis: false });
        return { ...built.plan, documentId: doc.id, version: doc.version };
    });
    res.json(result);
}));
/**
 * 提交行界调整：
 *   POST /api/documents/:id/reline
 *   { expectedVersion, op, lineId?, splitCp?, leftLineId?, rightLineId?, basis }
 * 版本过期 → 409；预览所依据的行已变化（basis 不符）→ 409 RELINE_STALE；
 * 二者皆整次拒绝、不写入、不推进版本。成功仅推进一次版本，
 * 响应回填拆分新行 id 与各片段落位（result 与预览同构）。
 */
exports.router.post('/documents/:id/reline', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const result = await (0, db_1.withTx)(async (c) => {
        const doc = await (0, repo_1.lockDoc)(c, id);
        (0, repo_1.checkVersion)(doc, req.body?.expectedVersion); // 版本过期 → 409，不写入
        const built = await (0, reline_1.buildReLinePlan)(c, doc, req.body ?? {}, {
            forUpdate: true,
            requireBasis: true,
            basis: req.body?.basis,
        });
        await (0, reline_1.applyReLinePlan)(c, built);
        await (0, repo_1.bumpVersion)(c, id); // 整次成功只推进一次
        const after = await (0, repo_1.getDoc)(c, id);
        return { version: after.version, result: built.plan };
    });
    res.json({ ok: true, ...result });
}));
// ---------- 批量行改（一次校订同一文献多份抄本的多份原始行） ----------
/**
 * 批量行改预览（只读，不推进版本）：
 *   POST /api/documents/:id/lines/batch-edit/preview  { edits: [{ lineId, startCp, endCp, replacement }] }
 * 返回各行新文字（lines[]）、片段新位置（fragments[]：unchanged/moved/broken）、
 * 受影响组（brokenGroups[]，区分新标待修复与原已待修复），以及提交须原样带回的 basis
 * 与当前文献 version。
 * 非法请求体 / 区间 / 跨文献行 / 区间重叠 / 同点重复插入 / 插入点落入他编辑区间（含端点）
 * → 400 且 details[] 逐条定位；行不存在 → 404。
 */
exports.router.post('/documents/:id/lines/batch-edit/preview', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const result = await (0, db_1.withTx)(async (c) => {
        const doc = await (0, repo_1.getDoc)(c, id);
        const { plan } = await (0, batchedit_1.buildPlanForEdits)(c, doc, req.body?.edits, {
            forUpdate: false,
            requireBasis: false,
        });
        return {
            documentId: doc.id,
            version: doc.version,
            editCount: plan.lines.reduce((n, l) => n + l.edits.length, 0),
            ...plan,
        };
    });
    res.json(result);
}));
/**
 * 提交批量行改：
 *   POST /api/documents/:id/lines/batch-edit
 *   { expectedVersion, edits: [...], basis }   // basis 原样带回预览响应中的 basis
 * 版本过期 → 409 整批拒绝且不写入；预览所依据的行已变化（basis 不符）→ 409 BATCH_EDIT_STALE；
 * 请求体重跑同样的区间 / 冲突 / 跨文献行校验（400 定位）。成功只推进一次版本，
 * 返回 { ok, version, result }（result 与预览同构）。已发布快照保持原样。
 */
exports.router.post('/documents/:id/lines/batch-edit', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const result = await (0, db_1.withTx)(async (c) => {
        const doc = await (0, repo_1.lockDoc)(c, id);
        (0, repo_1.checkVersion)(doc, req.body?.expectedVersion); // 版本过期 → 409，不写入
        const { plan } = await (0, batchedit_1.buildPlanForEdits)(c, doc, req.body?.edits, {
            forUpdate: true,
            requireBasis: true,
            basis: req.body?.basis,
        });
        await (0, batchedit_1.applyBatchEditPlan)(c, plan);
        await (0, repo_1.bumpVersion)(c, id); // 整批成功只推进一次
        const after = await (0, repo_1.getDoc)(c, id);
        return {
            version: after.version,
            result: {
                documentId: id,
                version: after.version,
                editCount: plan.lines.reduce((n, l) => n + l.edits.length, 0),
                ...plan,
            },
        };
    });
    res.json({ ok: true, ...result });
}));
// ---------- 发布 ----------
exports.router.post('/documents/:id/publish', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const result = await (0, db_1.withTx)(async (c) => {
        const doc = await (0, repo_1.lockDoc)(c, id);
        (0, repo_1.checkVersion)(doc, req.body?.expectedVersion);
        const mss = await (0, repo_1.loadMss)(c, id);
        if (mss.length < 2)
            throw new util_1.HttpError(400, '至少需要两份抄本才能发布校勘版');
        if (doc.base_ms_id == null)
            throw new util_1.HttpError(400, '尚未选定底本，不能发布');
        const { rows: broken } = await c.query('SELECT count(*)::int AS n FROM grp WHERE doc_id=$1 AND broken=TRUE', [id]);
        if (broken[0].n > 0) {
            throw new util_1.HttpError(409, `尚有 ${broken[0].n} 个对应组待修复，修复前不得发布新校勘版`, { brokenGroups: broken[0].n });
        }
        const { rows: gc } = await c.query('SELECT count(*)::int AS n FROM grp WHERE doc_id=$1', [id]);
        if (gc[0].n === 0)
            throw new util_1.HttpError(400, '还没有任何对应组，不能发布');
        const editionNo = doc.published_ver + 1;
        await c.query('UPDATE documents SET published_ver=$1 WHERE id=$2', [editionNo, id]);
        // 快照固化“发布定稿”状态：先落版本号（乐观锁 +1），再构建读模型，
        // 使快照 document.version 即该已发布版对应的版本号
        await (0, repo_1.bumpVersion)(c, id);
        const published = await (0, repo_1.getDoc)(c, id);
        const view = await (0, collation_1.buildView)(c, published);
        await c.query('INSERT INTO editions (doc_id, edition_no, snapshot) VALUES ($1,$2,$3)', [id, editionNo, JSON.stringify(view)]);
        return editionNo;
    });
    res.status(201).json({ editionNo: result });
}));
exports.router.get('/documents/:id/editions', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = await (0, db_1.query)('SELECT id, edition_no, created_at FROM editions WHERE doc_id=$1 ORDER BY edition_no DESC', [id]);
    res.json({ editions: rows });
}));
exports.router.get('/documents/:id/editions/:no', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const no = Number(req.params.no);
    const { rows } = await (0, db_1.query)('SELECT edition_no, snapshot, created_at FROM editions WHERE doc_id=$1 AND edition_no=$2', [id, no]);
    if (rows.length === 0)
        throw new util_1.HttpError(404, `校勘版 #${no} 不存在（旧版永久保留可读）`);
    res.json({ editionNo: rows[0].edition_no, createdAt: rows[0].created_at, view: rows[0].snapshot });
}));
/**
 * 版本对照：任一已发布校勘版（旧，不可变快照）vs 当前工作版（新，实时读模型）。
 * 只读：不修改工作版，也不修改任何快照；刷新后重新取即反映最新工作版。
 * 旧版不存在 → 404（错误信息明确指出该版不存在）。
 */
exports.router.get('/documents/:id/editions/:no/diff', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const no = Number(req.params.no);
    if (!(0, util_1.isInt)(no) || no < 1)
        throw new util_1.HttpError(400, '校勘版编号必须是正整数');
    const result = await (0, db_1.withTx)(async (c) => {
        const doc = await (0, repo_1.getDoc)(c, id);
        const { rows } = await c.query('SELECT snapshot, created_at FROM editions WHERE doc_id=$1 AND edition_no=$2', [id, no]);
        if (rows.length === 0) {
            throw new util_1.HttpError(404, doc.published_ver === 0
                ? `校勘版 #${no} 不存在：本文献尚未发布过任何校勘版`
                : `校勘版 #${no} 不存在：当前仅发布至第 ${doc.published_ver} 版`, { requestedEdition: no, latestEdition: doc.published_ver });
        }
        const oldView = rows[0].snapshot;
        const newView = await (0, collation_1.buildView)(c, doc);
        return (0, diff_1.buildEditionDiff)(oldView, newView, rows[0].created_at.toISOString());
    });
    res.json(result);
}));
/**
 * 恢复已发布校勘版：
 *   POST /api/documents/:id/editions/:no/restore  { expectedVersion }
 * 整理者在“发布与旧版”中选取已发布校勘版、查看它与当前工作版的对照后确认恢复。
 *  - expectedVersion 必须是对照时看到的当前工作版版本号；版本已变化 → 409，拒绝且不改动数据；
 *  - 目标版不存在 → 404，拒绝且不改动数据；
 *  - 快照内容无法构成合法归组（结构损坏 / 缺底本 / 越界 / 重叠 …）→ 409 RESTORE_SNAPSHOT_INVALID，
 *    details.issues 逐条说明，整体拒绝且不改动数据；
 *  - 恢复范围：抄本及顺序、底本、全部原始行、对应组片段与缺文标记；
 *    文献标题、已发布版编号和快照保持原样。
 * 成功后工作版版本号只前进一次，返回新版本号；重建后的行与组取得当前有效标识。
 */
exports.router.post('/documents/:id/editions/:no/restore', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const no = Number(req.params.no);
    if (!(0, util_1.isInt)(no) || no < 1)
        throw new util_1.HttpError(400, '校勘版编号必须是正整数');
    const result = await (0, db_1.withTx)(async (c) => {
        const doc = await (0, repo_1.lockDoc)(c, id);
        (0, repo_1.checkVersion)(doc, req.body?.expectedVersion); // 版本已变化 → 409，不改动数据
        const { rows } = await c.query('SELECT snapshot FROM editions WHERE doc_id=$1 AND edition_no=$2', [id, no]);
        if (rows.length === 0) {
            throw new util_1.HttpError(404, doc.published_ver === 0
                ? `校勘版 #${no} 不存在：本文献尚未发布过任何校勘版，无法恢复`
                : `校勘版 #${no} 不存在：当前仅发布至第 ${doc.published_ver} 版，无法恢复`, { requestedEdition: no, latestEdition: doc.published_ver });
        }
        // 解析快照并以同一套归组规则校验；无法构成合法归组 → 409 RESTORE_SNAPSHOT_INVALID（此前无任何写入）
        const plan = (0, restore_1.buildRestorePlan)(rows[0].snapshot);
        await (0, restore_1.applyRestore)(c, id, plan);
        await (0, repo_1.bumpVersion)(c, id); // 成功后工作版版本号只前进一次
        const after = await (0, repo_1.getDoc)(c, id);
        return {
            editionNo: no,
            version: after.version,
            restored: {
                manuscriptCount: plan.stats.manuscriptCount,
                lineCount: plan.stats.lineCount,
                groupCount: plan.stats.groupCount,
                fragmentCount: plan.stats.fragmentCount,
                missingCount: plan.stats.missingCount,
                baseMsId: plan.baseMsId,
            },
        };
    });
    res.json({ ok: true, ...result });
}));
