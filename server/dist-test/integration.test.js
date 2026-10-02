"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const assert = __importStar(require("assert"));
const http_1 = require("http");
const app_1 = require("./app");
const db_1 = require("./db");
// 使用真实 PostgreSQL 语义（PGlite / WASM）端到端校验全部业务规则。
async function startServer() {
    await (0, db_1.initSchema)();
    const server = (0, http_1.createServer)((0, app_1.createApp)());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    return {
        base: `http://127.0.0.1:${port}/api`,
        close: () => new Promise((r) => server.close(() => r())),
    };
}
let seq = 0;
async function call(base, method, url, body) {
    const res = await fetch(base + url, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
        json = await res.json();
    }
    catch {
        /* no body */
    }
    return { status: res.status, json };
}
async function expectFail(r, status, phrase) {
    assert.strictEqual(r.status, status, `期望 ${status}，实际 ${r.status}: ${JSON.stringify(r.json)}`);
    assert.ok(JSON.stringify(r.json).includes(phrase), `错误信息应包含「${phrase}」，实际：${JSON.stringify(r.json)}`);
}
async function main() {
    const { base, close } = await startServer();
    try {
        // ---------- 建档 ----------
        let r = await call(base, 'POST', '/documents', {
            title: `集成测试文献 ${++seq}`,
            manuscripts: ['甲本', '乙本', '丙本'],
        });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        const docId = r.json.id;
        let view = (await call(base, 'GET', `/documents/${docId}`)).json;
        const v1 = view.document.version;
        assert.strictEqual(v1, 1);
        const [msA, msB, msC] = view.manuscripts;
        assert.strictEqual(msA.name, '甲本');
        assert.ok(msA.isBase, '第一份抄本应为默认底本');
        // ---------- 逐行录文 ----------
        // 甲本（底本）：
        //  行1 天命之謂性率性之謂道
        //  行2 修道之謂教
        // 乙本：
        //  行1 天命之謂姓率性之謂道
        //  行2 修道之謂教也
        // 丙本：
        //  行1 天命之謂性
        //  行2 修道之謂教
        await call(base, 'POST', `/manuscripts/${msA.id}/lines`, { expectedVersion: v1, content: '天命之謂性率性之謂道' });
        await call(base, 'POST', `/manuscripts/${msA.id}/lines`, { expectedVersion: 2, content: '修道之謂教' });
        await call(base, 'POST', `/manuscripts/${msB.id}/lines`, { expectedVersion: 3, content: '天命之謂姓率性之謂道' });
        await call(base, 'POST', `/manuscripts/${msB.id}/lines`, { expectedVersion: 4, content: '修道之謂教也' });
        await call(base, 'POST', `/manuscripts/${msC.id}/lines`, { expectedVersion: 5, content: '天命之謂性' });
        await call(base, 'POST', `/manuscripts/${msC.id}/lines`, { expectedVersion: 6, content: '修道之謂教' });
        view = (await call(base, 'GET', `/documents/${docId}`)).json;
        const v7 = view.document.version;
        assert.strictEqual(v7, 7);
        const lines = (msId) => view.rawByMs.find((x) => x.msId === msId).lines;
        const a1 = lines(msA.id)[0].lineId;
        const a2 = lines(msA.id)[1].lineId;
        const b1 = lines(msB.id)[0].lineId;
        const b2 = lines(msB.id)[1].lineId;
        const c1 = lines(msC.id)[0].lineId;
        const c2 = lines(msC.id)[1].lineId;
        // ---------- 归组：合法整批 ----------
        const goodGroups = [
            // 组1 天命之謂性 / 天命之謂姓（异文）/ 天命之謂性
            { ord: 1, fragments: [
                    { msId: msA.id, lineId: a1, startCp: 0, endCp: 5 },
                    { msId: msB.id, lineId: b1, startCp: 0, endCp: 5 },
                    { msId: msC.id, lineId: c1, startCp: 0, endCp: 5 },
                ] },
            // 组2 率性之謂道 / 率性之謂道 / 缺文
            { ord: 2, fragments: [
                    { msId: msA.id, lineId: a1, startCp: 5, endCp: 10 },
                    { msId: msB.id, lineId: b1, startCp: 5, endCp: 10 },
                    { msId: msC.id, missing: true },
                ] },
            // 组3 修道之謂教（三者同文；丙本行2）
            { ord: 3, fragments: [
                    { msId: msA.id, lineId: a2, startCp: 0, endCp: 5 },
                    { msId: msB.id, lineId: b2, startCp: 0, endCp: 5 },
                    { msId: msC.id, lineId: c2, startCp: 0, endCp: 5 },
                ] },
        ];
        r = await call(base, 'PUT', `/documents/${docId}/groups`, { expectedVersion: v7, groups: goodGroups });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        view = (await call(base, 'GET', `/documents/${docId}`)).json;
        assert.strictEqual(view.stats.groupCount, 3);
        assert.strictEqual(view.stats.brokenCount, 0);
        assert.strictEqual(view.groups[0].variant, true, '性/姓应为异文');
        assert.strictEqual(view.groups[0].baseText, '天命之謂性');
        assert.strictEqual(view.groups[1].hasMissing, true, '丙本缺文');
        assert.strictEqual(view.groups[2].variant, false);
        // 未归组文字仍可见：乙本行2「也」无覆盖
        const b2view = view.rawByMs.find((x) => x.msId === msB.id).lines[1];
        assert.strictEqual(b2view.covered.length, 1);
        assert.strictEqual(b2view.covered[0].endCp, 5);
        // ---------- 错误：越界片段（须指出位置，不保存） ----------
        const badRange = JSON.parse(JSON.stringify(goodGroups));
        badRange[1].fragments[1] = { msId: msB.id, lineId: b1, startCp: 5, endCp: 99 };
        r = await call(base, 'PUT', `/documents/${docId}/groups`, { expectedVersion: view.document.version, groups: badRange });
        await expectFail(r, 400, '越界');
        assert.ok(r.json.details.some((d) => d.code === 'OUT_OF_RANGE' && d.lineNo === 1));
        // ---------- 错误：同一抄本重叠归组 ----------
        const overlap = JSON.parse(JSON.stringify(goodGroups));
        overlap[0].fragments[1] = { msId: msB.id, lineId: b1, startCp: 0, endCp: 6 }; // 与组2 [5,10) 重叠
        r = await call(base, 'PUT', `/documents/${docId}/groups`, { expectedVersion: view.document.version, groups: overlap });
        await expectFail(r, 400, '重叠归组');
        assert.ok(r.json.details.some((d) => d.code === 'OVERLAP'));
        // ---------- 错误：缺少底本片段 ----------
        const noBase = JSON.parse(JSON.stringify(goodGroups));
        noBase[0].fragments = noBase[0].fragments.filter((f) => f.msId !== msA.id);
        r = await call(base, 'PUT', `/documents/${docId}/groups`, { expectedVersion: view.document.version, groups: noBase });
        await expectFail(r, 400, '缺少底本片段');
        assert.ok(r.json.details.some((d) => d.code === 'NO_BASE'));
        // ---------- 错误：底本片段被标缺文 ----------
        const baseMissing = JSON.parse(JSON.stringify(goodGroups));
        baseMissing[0].fragments[0] = { msId: msA.id, missing: true };
        r = await call(base, 'PUT', `/documents/${docId}/groups`, { expectedVersion: view.document.version, groups: baseMissing });
        await expectFail(r, 400, '底本片段被标为缺文');
        // ---------- 错误：同组同抄本两个片段 ----------
        const dupMs = JSON.parse(JSON.stringify(goodGroups));
        dupMs[0].fragments.push({ msId: msB.id, lineId: b1, startCp: 8, endCp: 9 });
        r = await call(base, 'PUT', `/documents/${docId}/groups`, { expectedVersion: view.document.version, groups: dupMs });
        await expectFail(r, 400, '出现多个片段');
        // ---------- 错误：不能部分保存 —— 校验失败后已保存数据保持 3 组完好 ----------
        view = (await call(base, 'GET', `/documents/${docId}`)).json;
        assert.strictEqual(view.stats.groupCount, 3);
        assert.strictEqual(view.stats.brokenCount, 0);
        // ---------- 乐观锁：过期版本拒绝 ----------
        r = await call(base, 'PUT', `/documents/${docId}/groups`, { expectedVersion: v7, groups: goodGroups });
        await expectFail(r, 409, '版本已过期');
        r = await call(base, 'POST', `/manuscripts/${msA.id}/lines`, { expectedVersion: 1, content: '过期请求' });
        await expectFail(r, 409, '版本已过期');
        // ---------- 改原文：只使受影响组待修复 ----------
        // 乙本行1「天命之謂姓率性之謂道」把「姓」改为「性」（[4,5)），与组1相交
        r = await call(base, 'PUT', `/lines/${b1}`, { expectedVersion: view.document.version, startCp: 4, endCp: 5, replacement: '性' });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        view = (await call(base, 'GET', `/documents/${docId}`)).json;
        assert.strictEqual(view.stats.brokenCount, 1, '仅组1受影响');
        assert.strictEqual(view.groups[0].broken, true);
        assert.strictEqual(view.groups[1].broken, false);
        assert.strictEqual(view.groups[2].broken, false);
        const curVer = view.document.version;
        // 待修复期间不得发布
        r = await call(base, 'POST', `/documents/${docId}/publish`, { expectedVersion: curVer });
        await expectFail(r, 409, '待修复');
        // ---------- 修复组1（异文消失） ----------
        const g1id = view.groups[0].id;
        r = await call(base, 'PUT', `/documents/${docId}/groups/${g1id}/repair`, {
            expectedVersion: curVer,
            group: { ord: 1, fragments: [
                    { msId: msA.id, lineId: a1, startCp: 0, endCp: 5 },
                    { msId: msB.id, lineId: b1, startCp: 0, endCp: 5 },
                    { msId: msC.id, lineId: c1, startCp: 0, endCp: 5 },
                ] },
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        view = (await call(base, 'GET', `/documents/${docId}`)).json;
        assert.strictEqual(view.stats.brokenCount, 0);
        assert.strictEqual(view.groups[0].variant, false, '改字后甲乙一致，不再是异文');
        // 修复时与其他组重叠 → 拒绝
        r = await call(base, 'PUT', `/documents/${docId}/groups/${g1id}/repair`, {
            expectedVersion: view.document.version,
            group: { ord: 1, fragments: [
                    { msId: msA.id, lineId: a1, startCp: 0, endCp: 6 }, // 与组2 [5,10) 重叠
                    { msId: msB.id, lineId: b1, startCp: 0, endCp: 5 },
                    { msId: msC.id, lineId: c1, startCp: 0, endCp: 5 },
                ] },
        });
        await expectFail(r, 400, '重叠归组');
        // 失败的修复不得改动既有状态
        view = (await call(base, 'GET', `/documents/${docId}`)).json;
        assert.strictEqual(view.stats.brokenCount, 0);
        // ---------- 插入导致后方片段平移（不受影响、不待修复） ----------
        // 乙本行2「修道之謂教也」：在开头插入「曰」[0,0)。组3片段 [0,5) 与插入点端点相接（不相交）→ 平移到 [1,6)
        r = await call(base, 'PUT', `/lines/${b2}`, { expectedVersion: view.document.version, startCp: 0, endCp: 0, replacement: '曰' });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        view = (await call(base, 'GET', `/documents/${docId}`)).json;
        assert.strictEqual(view.stats.brokenCount, 0, '端点相接的插入不应使组待修复');
        const b2cell = view.groups[2].cells.find((c) => c.msId === msB.id);
        assert.strictEqual(b2cell.text, '修道之謂教', '平移后截取文字不变');
        assert.strictEqual(b2cell.startCp, 1);
        assert.strictEqual(b2cell.endCp, 6);
        // ---------- 缩短导致越界 → 待修复，且修复前不得发布 ----------
        // 把甲本行1删到只剩 3 字：组1 [0,5)、组2 [5,10) 都失效
        r = await call(base, 'PUT', `/lines/${a1}`, { expectedVersion: view.document.version, startCp: 3, endCp: 10, replacement: '' });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        view = (await call(base, 'GET', `/documents/${docId}`)).json;
        assert.strictEqual(view.stats.brokenCount, 2);
        r = await call(base, 'POST', `/documents/${docId}/publish`, { expectedVersion: view.document.version });
        await expectFail(r, 409, '不得发布');
        // 恢复原文（重新追加），再修复两组
        r = await call(base, 'PUT', `/lines/${a1}`, { expectedVersion: view.document.version, startCp: 3, endCp: 3, replacement: '之謂性率性之謂道' });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        view = (await call(base, 'GET', `/documents/${docId}`)).json;
        // 追加后区间仍保持原样且重新有效？[0,5) 现在合法、[5,10) 合法 —— 但组仍被标 broken（只增不减）
        assert.strictEqual(view.stats.brokenCount, 2);
        for (const g of view.groups.filter((x) => x.broken)) {
            const cells = g.cells;
            const rebuild = [];
            for (const ms of view.manuscripts) {
                const cell = cells.find((c) => c.msId === ms.id);
                if (cell.missing)
                    rebuild.push({ msId: ms.id, missing: true });
                else if (cell.startCp != null) {
                    // 重新定位行 id（按行号）
                    const ln = view.rawByMs.find((x) => x.msId === ms.id).lines.find((l) => l.lineNo === cell.lineNo);
                    rebuild.push({ msId: ms.id, lineId: ln.lineId, startCp: cell.startCp, endCp: cell.endCp });
                }
            }
            const rr = await call(base, 'PUT', `/documents/${docId}/groups/${g.id}/repair`, {
                expectedVersion: view.document.version,
                group: { ord: g.ord, fragments: rebuild },
            });
            assert.strictEqual(rr.status, 200, JSON.stringify(rr.json));
            view = (await call(base, 'GET', `/documents/${docId}`)).json;
        }
        assert.strictEqual(view.stats.brokenCount, 0);
        // ---------- 发布 ----------
        r = await call(base, 'POST', `/documents/${docId}/publish`, { expectedVersion: view.document.version });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        assert.strictEqual(r.json.editionNo, 1);
        view = (await call(base, 'GET', `/documents/${docId}`)).json;
        assert.strictEqual(view.document.publishedVer, 1);
        // 旧版可读（快照）
        const ed = (await call(base, 'GET', `/documents/${docId}/editions/1`)).json;
        assert.strictEqual(ed.view.document.title, view.document.title);
        assert.strictEqual(ed.view.groups.length, 3);
        const eds = (await call(base, 'GET', `/documents/${docId}/editions`)).json;
        assert.strictEqual(eds.editions.length, 1);
        // 发布后继续改原文 → 出现待修复，但旧版仍可读、且不允许发新版
        r = await call(base, 'PUT', `/lines/${a2}`, { expectedVersion: view.document.version, startCp: 0, endCp: 1, replacement: '脩' });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        view = (await call(base, 'GET', `/documents/${docId}`)).json;
        assert.ok(view.stats.brokenCount >= 1);
        r = await call(base, 'POST', `/documents/${docId}/publish`, { expectedVersion: view.document.version });
        await expectFail(r, 409, '不得发布');
        const oldEd = await call(base, 'GET', `/documents/${docId}/editions/1`);
        assert.strictEqual(oldEd.status, 200, '旧发布版必须仍可阅读');
        // ---------- 倒置检测：另建一文献 ----------
        r = await call(base, 'POST', '/documents', { title: `倒置测试 ${++seq}`, manuscripts: ['底', 'W'] });
        assert.strictEqual(r.status, 201);
        const d2 = r.json.id;
        let v2doc = (await call(base, 'GET', `/documents/${d2}`)).json;
        let ver = v2doc.document.version;
        const base2 = v2doc.manuscripts[0];
        const wit2 = v2doc.manuscripts[1];
        // 底：行1 AB；W：行1 BA
        await call(base, 'POST', `/manuscripts/${base2.id}/lines`, { expectedVersion: ver++, content: 'AB' });
        await call(base, 'POST', `/manuscripts/${wit2.id}/lines`, { expectedVersion: ver++, content: 'BA' });
        v2doc = (await call(base, 'GET', `/documents/${d2}`)).json;
        const bl = v2doc.rawByMs.find((x) => x.msId === base2.id).lines[0].lineId;
        const wl = v2doc.rawByMs.find((x) => x.msId === wit2.id).lines[0].lineId;
        // 组1: 底 A / W 第2字；组2: 底 B / W 第1字 → W 中顺序倒置
        r = await call(base, 'PUT', `/documents/${d2}/groups`, {
            expectedVersion: ver,
            groups: [
                { ord: 1, fragments: [
                        { msId: base2.id, lineId: bl, startCp: 0, endCp: 1 },
                        { msId: wit2.id, lineId: wl, startCp: 1, endCp: 2 },
                    ] },
                { ord: 2, fragments: [
                        { msId: base2.id, lineId: bl, startCp: 1, endCp: 2 },
                        { msId: wit2.id, lineId: wl, startCp: 0, endCp: 1 },
                    ] },
            ],
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        v2doc = (await call(base, 'GET', `/documents/${d2}`)).json;
        assert.ok(v2doc.groups[0].inverted && v2doc.groups[1].inverted, '两组都应标倒置');
        // ---------- 切底本：不含新底本片段的组待修复 ----------
        // 给 d2 加第三个抄本 C 并切为底本（其行无任何片段）
        r = await call(base, 'POST', `/documents/${d2}/manuscripts`, { expectedVersion: v2doc.document.version, name: 'C' });
        assert.strictEqual(r.status, 201);
        v2doc = (await call(base, 'GET', `/documents/${d2}`)).json;
        const cId3 = v2doc.manuscripts.find((m) => m.name === 'C').id;
        r = await call(base, 'PUT', `/documents/${d2}/base`, { expectedVersion: v2doc.document.version, msId: cId3 });
        assert.strictEqual(r.status, 200);
        v2doc = (await call(base, 'GET', `/documents/${d2}`)).json;
        assert.strictEqual(v2doc.stats.brokenCount, 2, '切换底本后原两组均缺新底本片段');
        // ---------- 版本对照：已发布校勘版 vs 当前工作版 ----------
        // 新建独立文献，避免受上面修复/改字流程干扰
        r = await call(base, 'POST', '/documents', { title: `版本对照测试 ${++seq}`, manuscripts: ['底甲', '乙', '丙'] });
        assert.strictEqual(r.status, 201);
        const d3 = r.json.id;
        let d3v = (await call(base, 'GET', `/documents/${d3}`)).json;
        let d3ver = d3v.document.version;
        const dmA = d3v.manuscripts[0]; // 底甲（默认底本）
        const dmB = d3v.manuscripts[1];
        const dmC = d3v.manuscripts[2];
        await call(base, 'POST', `/manuscripts/${dmA.id}/lines`, { expectedVersion: d3ver++, content: '天命之謂性' });
        await call(base, 'POST', `/manuscripts/${dmB.id}/lines`, { expectedVersion: d3ver++, content: '天命之謂姓' });
        await call(base, 'POST', `/manuscripts/${dmC.id}/lines`, { expectedVersion: d3ver++, content: '天命之謂性' });
        d3v = (await call(base, 'GET', `/documents/${d3}`)).json;
        const da1 = d3v.rawByMs.find((x) => x.msId === dmA.id).lines[0].lineId;
        const db1 = d3v.rawByMs.find((x) => x.msId === dmB.id).lines[0].lineId;
        const dc1 = d3v.rawByMs.find((x) => x.msId === dmC.id).lines[0].lineId;
        const groupsV1 = [
            { ord: 1, fragments: [
                    { msId: dmA.id, lineId: da1, startCp: 0, endCp: 5 },
                    { msId: dmB.id, lineId: db1, startCp: 0, endCp: 5 },
                    { msId: dmC.id, lineId: dc1, startCp: 0, endCp: 5 },
                ] },
        ];
        r = await call(base, 'PUT', `/documents/${d3}/groups`, { expectedVersion: d3v.document.version, groups: groupsV1 });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        const prePublishVersion = (await call(base, 'GET', `/documents/${d3}`)).json.document.version;
        r = await call(base, 'POST', `/documents/${d3}/publish`, { expectedVersion: prePublishVersion });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        assert.strictEqual(r.json.editionNo, 1);
        // 发布即定稿：快照版本号 = bump 后的工作版版本号（两侧均显示“版本号”）
        const v1version = (await call(base, 'GET', `/documents/${d3}`)).json.document.version;
        assert.strictEqual(v1version, prePublishVersion + 1);
        assert.strictEqual((await call(base, 'GET', `/documents/${d3}/editions/1`)).json.view.document.version, v1version);
        // 发布后：新增第 2 行（甲「率性之謂道」、乙同文、丙缺文），改乙第 1 行 姓→性，整批重存（组 ID 全部更换）
        await call(base, 'POST', `/manuscripts/${dmA.id}/lines`, { expectedVersion: v1version, content: '率性之謂道' });
        await call(base, 'POST', `/manuscripts/${dmB.id}/lines`, { expectedVersion: v1version + 1, content: '率性之謂道' });
        // 新增抄本丁（不录文）
        await call(base, 'POST', `/documents/${d3}/manuscripts`, { expectedVersion: v1version + 2, name: '丁' });
        r = await call(base, 'PUT', `/lines/${db1}`, {
            expectedVersion: v1version + 3, startCp: 4, endCp: 5, replacement: '性',
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        d3v = (await call(base, 'GET', `/documents/${d3}`)).json;
        const da2 = d3v.rawByMs.find((x) => x.msId === dmA.id).lines[1].lineId;
        const db2 = d3v.rawByMs.find((x) => x.msId === dmB.id).lines[1].lineId;
        const groupsV2 = [
            { ord: 1, fragments: [
                    { msId: dmA.id, lineId: da1, startCp: 0, endCp: 5 },
                    { msId: dmB.id, lineId: db1, startCp: 0, endCp: 5 },
                    { msId: dmC.id, lineId: dc1, startCp: 0, endCp: 5 },
                ] },
            { ord: 2, fragments: [
                    { msId: dmA.id, lineId: da2, startCp: 0, endCp: 5 },
                    { msId: dmB.id, lineId: db2, startCp: 0, endCp: 5 },
                    { msId: dmC.id, missing: true },
                ] },
        ];
        r = await call(base, 'PUT', `/documents/${d3}/groups`, { expectedVersion: d3v.document.version, groups: groupsV2 });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        const v2version = (await call(base, 'GET', `/documents/${d3}`)).json.document.version;
        let diff = (await call(base, 'GET', `/documents/${d3}/editions/1/diff`)).json;
        // 两侧底本与版本号
        assert.strictEqual(diff.sides.old.kind, 'edition');
        assert.strictEqual(diff.sides.old.editionNo, 1);
        assert.strictEqual(diff.sides.old.version, v1version, '旧侧版本号应为快照定稿时的版本号');
        assert.strictEqual(diff.sides.old.baseMsName, '底甲');
        assert.strictEqual(diff.sides.new.kind, 'working');
        assert.strictEqual(diff.sides.new.version, v2version);
        assert.strictEqual(diff.baseSame, true);
        // 行文：甲新增行2、乙行1改字 + 新增行2
        const a1Diff = diff.textChanges.find((t) => t.msId === dmA.id && t.lineNo === 1);
        assert.ok(!a1Diff, '甲行1未改动，不应出现');
        const a2Diff = diff.textChanges.find((t) => t.msId === dmA.id && t.lineNo === 2);
        assert.strictEqual(a2Diff.status, 'added');
        const b1Diff = diff.textChanges.find((t) => t.msId === dmB.id && t.lineNo === 1);
        assert.strictEqual(b1Diff.status, 'changed');
        assert.ok(b1Diff.segments.some((s) => s.op === 'removed' && s.text === '姓'), '应有删除「姓」');
        assert.ok(b1Diff.segments.some((s) => s.op === 'added' && s.text === '性'), '应有新增「性」');
        // 新增抄本丁
        assert.ok(diff.manuscripts.find((m) => m.name === '丁' && !m.inOld && m.inNew), '丁应为新增抄本');
        // 组配对：不得凭 ID——两组底本位置 [行1,0,5) 相同且唯一 → 配对；[行2,0,5) 仅新侧 → 新未配对
        assert.strictEqual(diff.groupDiff.counts.paired, 1);
        assert.strictEqual(diff.groupDiff.counts.unpairedOld, 0);
        assert.strictEqual(diff.groupDiff.counts.unpairedNew, 1);
        assert.strictEqual(diff.groupDiff.unpairedNew[0].reason, 'not-matched');
        assert.ok(diff.groupDiff.unpairedNew[0].cells.some((c) => c.msId === dmC.id && c.state === 'missing'), '未配对新组应显式呈现丙的缺文标记');
        const paired1 = diff.groupDiff.paired[0];
        assert.strictEqual(paired1.status, 'changed');
        assert.strictEqual(paired1.ordChanged, false);
        // 整批重存更换了组 ID，但仍能配对（不凭 ID）
        assert.notStrictEqual(paired1.oldGroupId, paired1.newGroupId);
        const bChange = paired1.cellChanges.find((c) => c.msId === dmB.id);
        assert.ok(bChange, '乙本片段应有变化条目');
        assert.strictEqual(bChange.textChanged, true, '姓→性为确定文字改动（两侧均完好）');
        assert.strictEqual(bChange.oldText, '天命之謂姓');
        assert.strictEqual(bChange.newText, '天命之謂性');
        assert.ok(!paired1.cellChanges.some((c) => c.msId === dmA.id), '甲本无变化，不应出现在变化条目里');
        // 对照是只读：再次取工作版版本号不变
        assert.strictEqual((await call(base, 'GET', `/documents/${d3}`)).json.document.version, v2version, '对照不得修改工作版');
        // 旧版不存在 → 404，错误信息明确
        r = await call(base, 'GET', `/documents/${d3}/editions/99/diff`);
        await expectFail(r, 404, '不存在');
        // 刷新即反映最新工作版：再做一次改动后重新对照，行文变化应包含新改动
        r = await call(base, 'PUT', `/lines/${da2}`, {
            expectedVersion: v2version, startCp: 0, endCp: 1, replacement: '脩',
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        diff = (await call(base, 'GET', `/documents/${d3}/editions/1/diff`)).json;
        // 甲第 2 行在旧版整行不存在 → 始终为“新增行”，改字后新增文本应是最新的「脩性之謂道」
        const a2AfterEdit = diff.textChanges.find((t) => t.msId === dmA.id && t.lineNo === 2);
        assert.strictEqual(a2AfterEdit.status, 'added');
        assert.ok(a2AfterEdit.newText.includes('脩') && !a2AfterEdit.newText.includes('修'), '刷新后新增行内容应反映最新工作版改字');
        // 乙第 2 行同为新增行，内容未受影响
        const b2AfterEdit = diff.textChanges.find((t) => t.msId === dmB.id && t.lineNo === 2);
        assert.strictEqual(b2AfterEdit.newText, '率性之謂道');
        // 改字与组2底本片段 [0,5) 相交 → 组2待修复；片段仍在行内：字面文字确定，但须显式标待修复
        let npAfterEdit = diff.groupDiff.unpairedNew.find((g) => g.ord === 2);
        assert.ok(npAfterEdit.broken, '相交改动后组2应为待修复并显式标识');
        const baseCellInRange = npAfterEdit.cells.find((c) => c.isBase);
        assert.strictEqual(baseCellInRange.broken, true);
        assert.strictEqual(baseCellInRange.outOfBounds, false, '行内片段不算越界');
        assert.strictEqual(baseCellInRange.text, '脩性之謂道', '行内待修复片段的字面文字仍为确定文字');
        // 真正缩短甲第 2 行至 3 字 → 组2底本片段 [0,5) 越界：现存部分不作确定文字
        d3v = (await call(base, 'GET', `/documents/${d3}`)).json;
        r = await call(base, 'PUT', `/lines/${da2}`, {
            expectedVersion: d3v.document.version, startCp: 3, endCp: 5, replacement: '',
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        diff = (await call(base, 'GET', `/documents/${d3}/editions/1/diff`)).json;
        npAfterEdit = diff.groupDiff.unpairedNew.find((g) => g.ord === 2);
        const baseCellOob = npAfterEdit.cells.find((c) => c.isBase);
        assert.ok(baseCellOob.broken && baseCellOob.outOfBounds, '缩短越界须显式标识');
        assert.strictEqual(baseCellOob.text, null, '越界片段不得作为确定文字');
        assert.strictEqual(baseCellOob.visibleText, '脩性之', '越界前可见部分仅供参考');
        assert.strictEqual(baseCellOob.oobEnd, 3);
        // 恢复甲第 2 行原文，供后续修复
        d3v = (await call(base, 'GET', `/documents/${d3}`)).json;
        r = await call(base, 'PUT', `/lines/${da2}`, {
            expectedVersion: d3v.document.version, startCp: 3, endCp: 3, replacement: '之謂道',
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        // ---------- 底本不同：组不配对，旧组与新组分别列出 ----------
        d3v = (await call(base, 'GET', `/documents/${d3}`)).json;
        // 先修复组2，使切底本场景干净
        const g2id = d3v.groups.find((g) => g.ord === 2).id;
        r = await call(base, 'PUT', `/documents/${d3}/groups/${g2id}/repair`, {
            expectedVersion: d3v.document.version,
            group: { ord: 2, fragments: [
                    { msId: dmA.id, lineId: da2, startCp: 0, endCp: 5 },
                    { msId: dmB.id, lineId: db2, startCp: 0, endCp: 5 },
                    { msId: dmC.id, missing: true },
                ] },
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        d3v = (await call(base, 'GET', `/documents/${d3}`)).json;
        // 切换底本到丙：两组均无丙的真实片段 → 全部待修复
        r = await call(base, 'PUT', `/documents/${d3}/base`, { expectedVersion: d3v.document.version, msId: dmC.id });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        diff = (await call(base, 'GET', `/documents/${d3}/editions/1/diff`)).json;
        assert.strictEqual(diff.baseSame, false, '两侧底本不同');
        assert.strictEqual(diff.groupDiff.counts.paired, 0, '底本不同不得配对');
        assert.strictEqual(diff.groupDiff.unpairedOld.length, 1, '旧版 1 组整组列出');
        assert.strictEqual(diff.groupDiff.unpairedNew.length, 2, '工作版 2 组整组列出');
        assert.ok(diff.groupDiff.unpairedNew.every((g) => g.reason === 'base-differs'), '底本不同原因须显式标注');
        const nbG1 = diff.groupDiff.unpairedNew.find((g) => g.ord === 1);
        const nbG2 = diff.groupDiff.unpairedNew.find((g) => g.ord === 2);
        assert.strictEqual(nbG1.broken, false, '组1含新底本丙的真实片段，不需待修复');
        assert.strictEqual(nbG2.broken, true, '组2新底本丙仅标缺文，须带待修复标识');
        assert.ok(diff.groupDiff.unpairedOld[0].cells.some((c) => c.isBase && c.text === '天命之謂性'), '旧组底本文字仍应确定呈现');
        // ---------- 补配：底本文字 → 目标抄本空闲区间候选 ----------
        // 甲（底）；乙（目标，尚无任何片段）；丁（另一无片段抄本）
        r = await call(base, 'POST', '/documents', { title: `补配测试 ${++seq}`, manuscripts: ['甲', '乙', '丁'] });
        assert.strictEqual(r.status, 201);
        const dS = r.json.id;
        let sView = (await call(base, 'GET', `/documents/${dS}`)).json;
        let sVer = sView.document.version;
        const [sA, sB, sD] = sView.manuscripts;
        // 甲（底本）行1（14 字，底本片段各占不重叠区间）：
        //  g1 天命 [0,2)  g2 丙丁 [2,4)  g3 丁戊 [4,6)  g4 戊己 [6,8)
        //  g5 庚辛 [8,10)  g6 壬癸 [10,12)  g7 子 [12,13)  g8 寅 [13,14)
        await call(base, 'POST', `/manuscripts/${sA.id}/lines`, {
            expectedVersion: sVer++, content: '天命丙丁丁戊戊己庚辛壬癸子丑寅',
        });
        // 乙（目标，行1；按码点偏移；字符 = 天命丙丁戊己丁戊己X壬癸寅子𠀀，X=占字占位使偏移固定）：
        //  天命[0,2) g1；丙丁[2,4) 与 丁戊[3,5) 候选互相重叠（冲突）；
        //  戊己[4,6) 与 [7,9) 两处空闲（multiple）；庚辛 无（none）；壬癸[10,12) 唯一；
        //  [8,9) 为 g7 已存在片段（占字「庚」，文字与 g7 无关，仅用于占区间→g7 排除、g8 命中处被占）；
        //  寅[13,14) 被 g7 片段? 否——g8 寅出现在 [12,13)，与 g7[8,9) 不冲突 → 直接改 g7 底本为寅使占用；
        //  末位𠀀为代理对（1 码点）
        await call(base, 'POST', `/manuscripts/${sB.id}/lines`, {
            expectedVersion: sVer++, content: '天命丙丁戊己丁戊己庚壬癸寅子𠀀',
        });
        // 丁：行1 只有「天命」
        await call(base, 'POST', `/manuscripts/${sD.id}/lines`, { expectedVersion: sVer++, content: '天命' });
        sView = (await call(base, 'GET', `/documents/${dS}`)).json;
        const sa1 = sView.rawByMs.find((x) => x.msId === sA.id).lines[0].lineId;
        const sb1 = sView.rawByMs.find((x) => x.msId === sB.id).lines[0].lineId;
        const sGroups = [
            { ord: 1, fragments: [{ msId: sA.id, lineId: sa1, startCp: 0, endCp: 2 }] }, // 天命
            { ord: 2, fragments: [{ msId: sA.id, lineId: sa1, startCp: 2, endCp: 4 }] }, // 丙丁
            { ord: 3, fragments: [{ msId: sA.id, lineId: sa1, startCp: 4, endCp: 6 }] }, // 丁戊
            { ord: 4, fragments: [{ msId: sA.id, lineId: sa1, startCp: 6, endCp: 8 }] }, // 戊己
            { ord: 5, fragments: [{ msId: sA.id, lineId: sa1, startCp: 8, endCp: 10 }] }, // 庚辛（无）
            { ord: 6, fragments: [{ msId: sA.id, lineId: sa1, startCp: 10, endCp: 12 }] }, // 壬癸
            { ord: 7, fragments: [
                    { msId: sA.id, lineId: sa1, startCp: 13, endCp: 14 }, // 寅
                    { msId: sB.id, lineId: sb1, startCp: 12, endCp: 13 }, // 寅（乙已有片段→排除、占住目标寅）
                ] },
        ];
        r = await call(base, 'PUT', `/documents/${dS}/groups`, { expectedVersion: sView.document.version, groups: sGroups });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        sView = (await call(base, 'GET', `/documents/${dS}`)).json;
        const gById = new Map(sView.groups.map((g) => [g.ord, g]));
        const verAfterGroups = sView.document.version;
        // 制造一个待修复组（改甲行使 g1 底本片段越界）：先补一个 g8 只在甲，再删短甲行后恢复组——
        // 直接改字相交即可令某组 broken：改甲行第 0 字相交 g1
        r = await call(base, 'PUT', `/lines/${sa1}`, {
            expectedVersion: sView.document.version, startCp: 0, endCp: 1, replacement: 'X',
        });
        assert.strictEqual(r.status, 200);
        sView = (await call(base, 'GET', `/documents/${dS}`)).json;
        assert.strictEqual(sView.groups.find((g) => g.ord === 1).broken, true, 'g1 应为待修复');
        // 恢复甲行文字（组仍 broken，只增不减）
        r = await call(base, 'PUT', `/lines/${sa1}`, {
            expectedVersion: sView.document.version, startCp: 0, endCp: 1, replacement: '天',
        });
        assert.strictEqual(r.status, 200);
        sView = (await call(base, 'GET', `/documents/${dS}`)).json;
        assert.strictEqual(sView.groups.find((g) => g.ord === 1).broken, true);
        // 对乙预览：g1 待修复排除；g7 乙已有片段排除；其余 g2..g6 纳入（5 组）
        let prev = (await call(base, 'GET', `/documents/${dS}/supplement/preview?targetMsId=${sB.id}`)).json;
        assert.strictEqual(prev.version, sView.document.version, '预览携带当前版本号');
        assert.strictEqual(prev.eligibleGroupCount, 5);
        assert.strictEqual(prev.excludedGroupCount, 2, 'g1 待修复 + g7 已有片段');
        const pByOrd = new Map(prev.groups.map((g) => [g.ord, g]));
        // g2 丙丁：候选 [2,4) 唯一，但与 g3 丁戊候选 [3,5) 重叠 → conflict，不可直接采纳
        const pg2 = pByOrd.get(2);
        assert.strictEqual(pg2.status, 'conflict');
        assert.strictEqual(pg2.adoptable, false);
        assert.strictEqual(pg2.candidates.length, 1);
        assert.deepStrictEqual(pg2.candidates[0].conflictsWithGroupIds, [gById.get(3).id]);
        // g3 丁戊本身两处（multiple），其中 [3,5) 与 g2 冲突、[6,8) 与 g4 冲突，均显式标出
        const pg3 = pByOrd.get(3);
        assert.strictEqual(pg3.status, 'multiple');
        assert.deepStrictEqual(pg3.candidates.map((x) => [x.startCp, x.endCp]), [[3, 5], [6, 8]]);
        assert.deepStrictEqual(pg3.candidates[0].conflictsWithGroupIds, [gById.get(2).id, gById.get(4).id]);
        // g4 戊己：[4,6) 与 [7,9) 两处空闲 → multiple
        const pg4 = pByOrd.get(4);
        assert.strictEqual(pg4.status, 'multiple');
        assert.strictEqual(pg4.adoptable, false);
        assert.strictEqual(pg4.candidates.length, 2);
        assert.deepStrictEqual(pg4.candidates.map((x) => [x.startCp, x.endCp]), [[4, 6], [7, 9]]);
        // g5 庚辛：无候选
        assert.strictEqual(pByOrd.get(5).status, 'none');
        assert.strictEqual(pByOrd.get(5).candidates.length, 0);
        // g6 壬癸：[10,12) 唯一无冲突 → unique 可直接采纳
        const pg6 = pByOrd.get(6);
        assert.strictEqual(pg6.status, 'unique');
        assert.strictEqual(pg6.adoptable, true);
        assert.strictEqual(pg6.candidates[0].lineNo, 1);
        assert.strictEqual(pg6.candidates[0].startCp, 10);
        assert.strictEqual(pg6.candidates[0].endCp, 12);
        // 预览只读：版本不变
        assert.strictEqual((await call(base, 'GET', `/documents/${dS}`)).json.document.version, sView.document.version);
        // 目标抄本 = 底本：所有完好组都已有底本片段，纳入 0 组
        const prevBase = (await call(base, 'GET', `/documents/${dS}/supplement/preview?targetMsId=${sA.id}`)).json;
        assert.strictEqual(prevBase.eligibleGroupCount, 0);
        // 缺 targetMsId → 400；非本文献抄本 → 400
        await expectFail(await call(base, 'GET', `/documents/${dS}/supplement/preview`), 400, 'targetMsId');
        // 对丁预览：g2..g7 均无同文（丁行只有「天命」），全部 none
        const prevD = (await call(base, 'GET', `/documents/${dS}/supplement/preview?targetMsId=${sD.id}`)).json;
        assert.strictEqual(prevD.eligibleGroupCount, 6);
        assert.ok(prevD.groups.every((g) => g.status === 'none'), '丁行无其余底本文字');
        // 码点安全：乙行末「𠀀」为代理对；修复 g1 时把底本片段指向甲第 2 行的「天命」之外的𠀀，
        // 验证候选按码点计 1。甲第 2 行仅含该扩展 B 区字。
        await call(base, 'POST', `/manuscripts/${sA.id}/lines`, { expectedVersion: sView.document.version, content: '𠀀' });
        sView = (await call(base, 'GET', `/documents/${dS}`)).json;
        const sa2 = sView.rawByMs.find((x) => x.msId === sA.id).lines.find((l) => l.lineNo === 2).lineId;
        r = await call(base, 'PUT', `/documents/${dS}/groups/${gById.get(1).id}/repair`, {
            expectedVersion: sView.document.version,
            group: { ord: 1, fragments: [{ msId: sA.id, lineId: sa2, startCp: 0, endCp: 1 }] },
        });
        assert.strictEqual(r.status, 200, `把 g1 修复为底本「𠀀」: ${JSON.stringify(r.json)}`);
        prev = (await call(base, 'GET', `/documents/${dS}/supplement/preview?targetMsId=${sB.id}`)).json;
        const pg1 = prev.groups.find((g) => g.ord === 1);
        assert.ok(pg1, 'g1 修复后应纳入补配');
        assert.strictEqual(pg1.status, 'unique');
        assert.strictEqual(pg1.candidates[0].startCp, 14, '𠀀 按码点为第 15 字（偏移 14）');
        assert.strictEqual(pg1.candidates[0].endCp, 15);
        assert.strictEqual(pg1.candidates[0].text, '𠀀');
        const verBeforeCommit = (await call(base, 'GET', `/documents/${dS}`)).json.document.version;
        // 冲突组各选一处（g2 丙丁 [2,4) + g3 丁戊 [3,5)，预览已标 conflict）：
        // 提交时在当前版重核为候选互相重叠 → 409 SELECTION_OVERLAP，整批拒绝、不写入、不推进
        r = await call(base, 'POST', `/documents/${dS}/supplement`, {
            expectedVersion: verBeforeCommit,
            targetMsId: sB.id,
            selections: [
                { groupId: gById.get(2).id, msId: sB.id, lineId: sb1, startCp: 2, endCp: 4 },
                { groupId: gById.get(3).id, msId: sB.id, lineId: sb1, startCp: 3, endCp: 5 },
            ],
        });
        await expectFail(r, 409, '候选失效');
        assert.ok(r.json.details.issues.some((i) => i.code === 'SELECTION_OVERLAP'));
        assert.strictEqual((await call(base, 'GET', `/documents/${dS}`)).json.document.version, verBeforeCommit, '重叠整批拒绝不推进');
        // 提交：g1(𠀀) + g2(丙丁) + g4 第二处(戊己 [7,9)) + g6(壬癸)；
        // 跳过冲突对的 g3、多候选 g4 第一处、无候选 g5、已有片段 g7
        r = await call(base, 'POST', `/documents/${dS}/supplement`, {
            expectedVersion: verBeforeCommit,
            targetMsId: sB.id,
            selections: [
                { groupId: gById.get(1).id, msId: sB.id, lineId: sb1, startCp: 14, endCp: 15 },
                { groupId: gById.get(2).id, msId: sB.id, lineId: sb1, startCp: 2, endCp: 4 },
                { groupId: gById.get(4).id, msId: sB.id, lineId: sb1, startCp: 7, endCp: 9 },
                { groupId: gById.get(6).id, msId: sB.id, lineId: sb1, startCp: 10, endCp: 12 },
            ],
        });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        assert.strictEqual(r.json.applied, 4);
        assert.strictEqual(r.json.version, verBeforeCommit + 1, '整批只推进一次版本');
        // 写入后读模型：相应组在乙有同文片段，未选组保持不变
        sView = (await call(base, 'GET', `/documents/${dS}`)).json;
        for (const ord of [1, 2, 4, 6]) {
            const cell = sView.groups.find((g) => g.ord === ord).cells.find((c) => c.msId === sB.id);
            assert.ok(cell && !cell.missing && cell.startCp != null, `g${ord} 应已有乙片段`);
        }
        const g3cell = sView.groups.find((g) => g.ord === 3).cells.find((c) => c.msId === sB.id);
        assert.ok(!g3cell || (!g3cell.missing && g3cell.startCp == null), '未选的 g3 不应被写入');
        assert.strictEqual(sView.stats.brokenCount, 0, '补配不改变待修复状态，且现已无待修复');
        // 重新预览：已补配的 g1/g2/g4/g6 与 g7 排除，仅余 g3、g5；
        //  g3「丁戊」[3,5) 与新写入的 g2 片段 [2,4) 重叠 → 不再是候选 → none
        prev = (await call(base, 'GET', `/documents/${dS}/supplement/preview?targetMsId=${sB.id}`)).json;
        assert.strictEqual(prev.eligibleGroupCount, 2);
        assert.strictEqual(prev.groups.find((g) => g.ord === 3).status, 'none', '冲突对方被采纳后，g3 候选因占用现存片段而消失');
        assert.strictEqual(prev.groups.find((g) => g.ord === 5).status, 'none');
        // 过期版本提交 → 409，不写入、不推进
        const verNow = (await call(base, 'GET', `/documents/${dS}`)).json.document.version;
        r = await call(base, 'POST', `/documents/${dS}/supplement`, {
            expectedVersion: verBeforeCommit,
            targetMsId: sD.id,
            selections: [{ groupId: gById.get(1).id, msId: sD.id, lineId: sa2, startCp: 0, endCp: 1 }],
        });
        await expectFail(r, 409, '版本已过期');
        assert.strictEqual((await call(base, 'GET', `/documents/${dS}`)).json.document.version, verNow, '409 不推进版本');
        // 候选失效：对丁提交 g1（丁行无「𠀀」）→ 409 整批拒绝、不推进、原因 TEXT_MISMATCH/越界
        r = await call(base, 'POST', `/documents/${dS}/supplement`, {
            expectedVersion: verNow,
            targetMsId: sD.id,
            selections: [
                { groupId: gById.get(1).id, msId: sD.id, lineId: sa2, startCp: 0, endCp: 1 }, // 行属于甲，不属于丁
            ],
        });
        await expectFail(r, 409, '候选失效');
        assert.ok(r.json.details.issues.some((i) => i.code === 'BAD_LINE'));
        assert.strictEqual(r.json.details.code, 'SUPPLEMENT_STALE');
        assert.strictEqual((await call(base, 'GET', `/documents/${dS}`)).json.document.version, verNow);
        // 候选失效：对乙再次提交 g6（乙已有该片段）→ ALREADY_HAS_FRAGMENT
        r = await call(base, 'POST', `/documents/${dS}/supplement`, {
            expectedVersion: verNow,
            targetMsId: sB.id,
            selections: [{ groupId: gById.get(6).id, msId: sB.id, lineId: sb1, startCp: 10, endCp: 12 }],
        });
        await expectFail(r, 409, '候选失效');
        assert.ok(r.json.details.issues.some((i) => i.code === 'ALREADY_HAS_FRAGMENT'));
        // 请求体非法：区间非法 / 同一组两个候选 → 400（不写库、不推进）
        r = await call(base, 'POST', `/documents/${dS}/supplement`, {
            expectedVersion: verNow,
            targetMsId: sB.id,
            selections: [{ groupId: gById.get(3).id, msId: sB.id, lineId: sb1, startCp: 0, endCp: 0 }],
        });
        await expectFail(r, 400, '区间非法');
        r = await call(base, 'POST', `/documents/${dS}/supplement`, {
            expectedVersion: verNow,
            targetMsId: sD.id,
            selections: [
                { groupId: gById.get(6).id, msId: sD.id, lineId: sb1, startCp: 0, endCp: 1 },
                { groupId: gById.get(6).id, msId: sD.id, lineId: sb1, startCp: 1, endCp: 2 },
            ],
        });
        await expectFail(r, 400, '同一组');
        // 空 selections → 400
        await expectFail(await call(base, 'POST', `/documents/${dS}/supplement`, { expectedVersion: verNow, targetMsId: sD.id, selections: [] }), 400, 'selections');
        // 已被占用区间 / 文字不符：新增甲第 3 行「子寅」，整批重存当前全部组 + g8(底本子) + g9(底本寅)。
        //  g9「寅」在乙行唯一出现处 [12,13) 被 g7 片段占用 → 无候选、提交 OCCUPIED；
        //  g8「子」在乙行无出现 → 无候选；提交空闲 [13,14)（寅≠子）→ TEXT_MISMATCH。
        await call(base, 'POST', `/manuscripts/${sA.id}/lines`, { expectedVersion: verNow, content: '子寅' });
        sView = (await call(base, 'GET', `/documents/${dS}`)).json;
        const saExtra = sView.rawByMs.find((x) => x.msId === sA.id).lines.find((l) => l.lineNo === 3).lineId;
        const verAfterExtraLine = sView.document.version;
        const rebuilt = sView.groups.map((g) => ({
            ord: g.ord,
            fragments: g.cells
                .filter((c) => c.missing || c.startCp != null)
                .map((c) => {
                if (c.missing)
                    return { msId: c.msId, missing: true };
                const ln = sView.rawByMs.find((x) => x.msId === c.msId)
                    .lines.find((l) => l.lineNo === c.lineNo);
                return { msId: c.msId, lineId: ln.lineId, startCp: c.startCp, endCp: c.endCp };
            }),
        }));
        rebuilt.push({ ord: rebuilt.length + 1, fragments: [{ msId: sA.id, lineId: saExtra, startCp: 0, endCp: 1 }] }); // g8 子
        rebuilt.push({ ord: rebuilt.length + 1, fragments: [{ msId: sA.id, lineId: saExtra, startCp: 1, endCp: 2 }] }); // g9 寅
        r = await call(base, 'PUT', `/documents/${dS}/groups`, { expectedVersion: verAfterExtraLine, groups: rebuilt });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        sView = (await call(base, 'GET', `/documents/${dS}`)).json;
        const verAfterG8 = sView.document.version;
        const g8id = sView.groups.find((g) => g.ord === 8).id;
        const g9id = sView.groups.find((g) => g.ord === 9).id;
        const gnewPrev = (await call(base, 'GET', `/documents/${dS}/supplement/preview?targetMsId=${sB.id}`)).json;
        assert.strictEqual(gnewPrev.groups.find((g) => g.groupId === g8id).status, 'unique', '乙行「子」[13,14) 空闲唯一');
        assert.strictEqual(gnewPrev.groups.find((g) => g.groupId === g9id).status, 'none', '乙行「寅」唯一出现处 [12,13) 已被 g7 片段占用，g9 无空闲候选');
        // g9 强行提交被占区间 → OCCUPIED
        r = await call(base, 'POST', `/documents/${dS}/supplement`, {
            expectedVersion: verAfterG8,
            targetMsId: sB.id,
            selections: [{ groupId: g9id, msId: sB.id, lineId: sb1, startCp: 12, endCp: 13 }],
        });
        await expectFail(r, 409, '候选失效');
        assert.ok(r.json.details.issues.some((i) => i.code === 'OCCUPIED'));
        // g8 唯一空闲候选直接采纳成功（此时 [13,14) 仍空闲）
        r = await call(base, 'POST', `/documents/${dS}/supplement`, {
            expectedVersion: verAfterG8,
            targetMsId: sB.id,
            selections: [{ groupId: g8id, msId: sB.id, lineId: sb1, startCp: 13, endCp: 14 }],
        });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        assert.strictEqual(r.json.applied, 1);
        const verAfterG8Apply = r.json.version;
        // 文字不符：g9 底本「寅」提交 [13,14)，该位置现已是 g8「子」→ TEXT_MISMATCH（同时也 OCCUPIED）
        r = await call(base, 'POST', `/documents/${dS}/supplement`, {
            expectedVersion: verAfterG8Apply,
            targetMsId: sB.id,
            selections: [{ groupId: g9id, msId: sB.id, lineId: sb1, startCp: 13, endCp: 14 }],
        });
        await expectFail(r, 409, '候选失效');
        assert.ok(r.json.details.issues.some((i) => i.code === 'TEXT_MISMATCH' || i.code === 'OCCUPIED'));
        assert.strictEqual((await call(base, 'GET', `/documents/${dS}`)).json.document.version, verAfterG8Apply, '失败不推进版本');
        // 不存在文献的预览 → 404
        await expectFail(await call(base, 'GET', `/documents/999999/supplement/preview?targetMsId=1`), 404, '不存在');
        // ---------- 行界调整：拆分原始行（不改变字序） ----------
        r = await call(base, 'POST', '/documents', { title: `行界拆分测试 ${++seq}`, manuscripts: ['甲', '乙', '丙'] });
        assert.strictEqual(r.status, 201);
        const dR = r.json.id;
        let rView = (await call(base, 'GET', `/documents/${dR}`)).json;
        let rVer = rView.document.version;
        const [rA, rB, rC] = rView.manuscripts;
        assert.ok(rA.isBase);
        await call(base, 'POST', `/manuscripts/${rA.id}/lines`, { expectedVersion: rVer++, content: '天命之謂性率性之謂道' });
        await call(base, 'POST', `/manuscripts/${rA.id}/lines`, { expectedVersion: rVer++, content: '修道之謂教' });
        await call(base, 'POST', `/manuscripts/${rA.id}/lines`, { expectedVersion: rVer++, content: '君子之道' });
        await call(base, 'POST', `/manuscripts/${rB.id}/lines`, { expectedVersion: rVer++, content: '天命之謂姓率性之謂道' });
        await call(base, 'POST', `/manuscripts/${rB.id}/lines`, { expectedVersion: rVer++, content: '修道之謂教也' });
        await call(base, 'POST', `/manuscripts/${rC.id}/lines`, { expectedVersion: rVer++, content: '子𠀀丑' });
        rView = (await call(base, 'GET', `/documents/${dR}`)).json;
        const rLines = (msId) => rView.rawByMs.find((x) => x.msId === msId).lines;
        const ra = (no) => rLines(rA.id).find((l) => l.lineNo === no).lineId;
        const rb = (no) => rLines(rB.id).find((l) => l.lineNo === no).lineId;
        const rc = (no) => rLines(rC.id).find((l) => l.lineNo === no).lineId;
        r = await call(base, 'PUT', `/documents/${dR}/groups`, {
            expectedVersion: rView.document.version,
            groups: [
                { ord: 1, fragments: [
                        { msId: rA.id, lineId: ra(1), startCp: 0, endCp: 5 },
                        { msId: rB.id, lineId: rb(1), startCp: 0, endCp: 5 },
                    ] },
                { ord: 2, fragments: [
                        { msId: rA.id, lineId: ra(1), startCp: 5, endCp: 10 },
                        { msId: rB.id, lineId: rb(1), startCp: 5, endCp: 10 },
                    ] },
                { ord: 3, fragments: [
                        { msId: rA.id, lineId: ra(2), startCp: 0, endCp: 5 },
                        { msId: rB.id, lineId: rb(2), startCp: 0, endCp: 5 },
                        { msId: rC.id, missing: true },
                    ] },
            ],
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        // 预览拆分 甲行1 @5：不跨任何片段（端点相接不算跨）
        rView = (await call(base, 'GET', `/documents/${dR}`)).json;
        let rVerBefore = rView.document.version;
        let rPrev = (await call(base, 'GET', `/documents/${dR}/reline/preview?op=split&lineId=${ra(1)}&splitCp=5`)).json;
        assert.strictEqual(rPrev.version, rVerBefore, '预览携带当前文献版本号');
        assert.strictEqual(rPrev.op, 'split');
        assert.strictEqual(rPrev.msId, rA.id);
        assert.strictEqual(rPrev.splitCp, 5);
        assert.deepStrictEqual(rPrev.basis, { lineId: ra(1), lineNo: 1, content: '天命之謂性率性之謂道', lengthCp: 10 });
        assert.deepStrictEqual(rPrev.lines.map((l) => [l.lineNo, l.oldLineNo, l.content, l.origin]), [
            [1, 1, '天命之謂性', 'split-left'],
            [2, 1, '率性之謂道', 'split-right'],
            [3, 2, '修道之謂教', 'shifted'],
            [4, 3, '君子之道', 'shifted'],
        ]);
        assert.strictEqual(rPrev.lines[1].lineId, null, '拆分出的新行预览时暂无 id');
        const spf1 = rPrev.fragments.find((f) => f.groupOrd === 1);
        assert.strictEqual(spf1.status, 'unchanged');
        assert.deepStrictEqual([spf1.newLineId, spf1.newLineNo, spf1.newStartCp, spf1.newEndCp], [ra(1), 1, 0, 5]);
        const spf2 = rPrev.fragments.find((f) => f.groupOrd === 2);
        assert.strictEqual(spf2.status, 'moved');
        assert.strictEqual(spf2.newLineId, null);
        assert.deepStrictEqual([spf2.newLineNo, spf2.newStartCp, spf2.newEndCp], [2, 0, 5]);
        assert.strictEqual(rPrev.brokenGroups.length, 0, '拆分点未跨片段，无新增待修复');
        // 预览只读：版本不变
        assert.strictEqual((await call(base, 'GET', `/documents/${dR}`)).json.document.version, rVerBefore);
        // 提交拆分：成功仅推进一次版本；未跨点片段随文字迁移并重算区间
        r = await call(base, 'POST', `/documents/${dR}/reline`, {
            expectedVersion: rVerBefore, op: 'split', lineId: ra(1), splitCp: 5, basis: rPrev.basis,
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert.strictEqual(r.json.version, rVerBefore + 1, '成功仅推进一次版本');
        const newRightLineId = r.json.result.lines.find((l) => l.origin === 'split-right').lineId;
        assert.ok(Number.isInteger(newRightLineId), '提交响应回填拆分新行 id');
        assert.strictEqual(r.json.result.fragments.find((f) => f.groupOrd === 2).newLineId, newRightLineId);
        rView = (await call(base, 'GET', `/documents/${dR}`)).json;
        assert.strictEqual(rView.document.version, rVerBefore + 1);
        assert.deepStrictEqual(rLines(rA.id).map((l) => [l.lineNo, l.content]), [
            [1, '天命之謂性'], [2, '率性之謂道'], [3, '修道之謂教'], [4, '君子之道'],
        ]);
        assert.strictEqual(rView.stats.brokenCount, 0, '未跨拆分点，无待修复');
        const rg2base = rView.groups.find((g) => g.ord === 2).cells.find((c) => c.msId === rA.id);
        assert.deepStrictEqual([rg2base.lineNo, rg2base.startCp, rg2base.endCp, rg2base.text], [2, 0, 5, '率性之謂道']);
        const rg3c = rView.groups.find((g) => g.ord === 3).cells.find((c) => c.msId === rC.id);
        assert.strictEqual(rg3c.missing, true, '缺文标记不变');
        // 非法码点位置 → 400 明确拒绝
        for (const bad of [0, 10, 11, -1]) {
            r = await call(base, 'GET', `/documents/${dR}/reline/preview?op=split&lineId=${rb(1)}&splitCp=${bad}`);
            await expectFail(r, 400, '拆分点非法');
        }
        r = await call(base, 'GET', `/documents/${dR}/reline/preview?op=split&lineId=${rb(1)}`);
        await expectFail(r, 400, 'splitCp');
        r = await call(base, 'GET', `/documents/${dR}/reline/preview?op=split&lineId=${rb(1)}&splitCp=1.5`);
        await expectFail(r, 400, 'splitCp');
        // 行不存在 → 404；不属于本文献的行 → 400；op 非法 → 400；文献不存在 → 404
        await expectFail(await call(base, 'GET', `/documents/${dR}/reline/preview?op=split&lineId=999999&splitCp=1`), 404, '不存在');
        await expectFail(await call(base, 'GET', `/documents/${dR}/reline/preview?op=split&lineId=${a1}&splitCp=1`), 400, '不属于本文献');
        await expectFail(await call(base, 'GET', `/documents/${dR}/reline/preview?op=x&lineId=${rb(1)}&splitCp=1`), 400, 'op');
        await expectFail(await call(base, 'GET', `/documents/999999/reline/preview?op=split&lineId=1&splitCp=1`), 404, '不存在');
        // 扩展 B 区生僻字按码点拆分：丙行1「子𠀀丑」共 3 码点（𠀀 为代理对）
        rView = (await call(base, 'GET', `/documents/${dR}`)).json;
        rVerBefore = rView.document.version;
        rPrev = (await call(base, 'GET', `/documents/${dR}/reline/preview?op=split&lineId=${rc(1)}&splitCp=2`)).json;
        assert.strictEqual(rPrev.basis.lengthCp, 3, '𠀀 按 1 码点计');
        assert.strictEqual(rPrev.lines[0].content, '子𠀀');
        assert.strictEqual(rPrev.lines[1].content, '丑');
        r = await call(base, 'POST', `/documents/${dR}/reline`, {
            expectedVersion: rVerBefore, op: 'split', lineId: rc(1), splitCp: 2, basis: rPrev.basis,
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        rView = (await call(base, 'GET', `/documents/${dR}`)).json;
        assert.deepStrictEqual(rLines(rC.id).map((l) => [l.lineNo, l.content]), [[1, '子𠀀'], [2, '丑']]);
        // 拆分后「丑」仅 1 字，无法再行内拆分 → 400
        await expectFail(await call(base, 'GET', `/documents/${dR}/reline/preview?op=split&lineId=${rc(2)}&splitCp=1`), 400, '无法在行内拆分');
        // 提交缺 basis → 400；版本过期 → 409 不推进；basis 不符（预览所依据的行已变化）→ 409 不推进
        rView = (await call(base, 'GET', `/documents/${dR}`)).json;
        rVerBefore = rView.document.version;
        r = await call(base, 'POST', `/documents/${dR}/reline`, { expectedVersion: rVerBefore, op: 'split', lineId: rb(1), splitCp: 4 });
        await expectFail(r, 400, 'basis');
        r = await call(base, 'POST', `/documents/${dR}/reline`, {
            expectedVersion: rVerBefore - 1, op: 'split', lineId: rb(1), splitCp: 4,
            basis: { lineId: rb(1), lineNo: 1, content: '天命之謂姓率性之謂道', lengthCp: 10 },
        });
        await expectFail(r, 409, '版本已过期');
        rPrev = (await call(base, 'GET', `/documents/${dR}/reline/preview?op=split&lineId=${rb(1)}&splitCp=4`)).json;
        r = await call(base, 'POST', `/documents/${dR}/reline`, {
            expectedVersion: rVerBefore, op: 'split', lineId: rb(1), splitCp: 4,
            basis: { ...rPrev.basis, content: '天命之謂性率性之謂道' },
        });
        await expectFail(r, 409, '已变化');
        assert.strictEqual(r.json.details.code, 'RELINE_STALE');
        assert.strictEqual((await call(base, 'GET', `/documents/${dR}`)).json.document.version, rVerBefore, '拒绝不推进版本');
        // 跨拆分点：乙行1「天命之謂姓率性之謂道」@4 → 组1 乙片段 [0,5) 跨点 → 待修复；组2 乙 [5,10) 迁新行
        assert.strictEqual(rPrev.fragments.find((f) => f.groupOrd === 1).status, 'broken');
        assert.deepStrictEqual((({ newLineId, newLineNo, newStartCp, newEndCp }) => [newLineId, newLineNo, newStartCp, newEndCp])(rPrev.fragments.find((f) => f.groupOrd === 1)), [rb(1), 1, 0, 5], '跨点片段保留原行原区间以便追溯');
        const xpf2 = rPrev.fragments.find((f) => f.groupOrd === 2);
        assert.strictEqual(xpf2.status, 'moved');
        assert.deepStrictEqual([xpf2.newLineNo, xpf2.newStartCp, xpf2.newEndCp], [2, 1, 6]);
        assert.strictEqual(rPrev.brokenGroups.length, 1);
        assert.strictEqual(rPrev.brokenGroups[0].newlyBroken, true);
        assert.strictEqual(rPrev.brokenGroups[0].ord, 1);
        r = await call(base, 'POST', `/documents/${dR}/reline`, {
            expectedVersion: rVerBefore, op: 'split', lineId: rb(1), splitCp: 4, basis: rPrev.basis,
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert.strictEqual(r.json.version, rVerBefore + 1);
        rView = (await call(base, 'GET', `/documents/${dR}`)).json;
        assert.deepStrictEqual(rLines(rB.id).map((l) => [l.lineNo, l.content]), [
            [1, '天命之謂'], [2, '姓率性之謂道'], [3, '修道之謂教也'],
        ]);
        assert.strictEqual(rView.stats.brokenCount, 1);
        const xg1 = rView.groups.find((g) => g.ord === 1);
        assert.strictEqual(xg1.broken, true);
        const xg1b = xg1.cells.find((c) => c.msId === rB.id);
        assert.strictEqual(xg1b.broken, true);
        assert.deepStrictEqual([xg1b.lineNo, xg1b.startCp, xg1b.endCp], [1, 0, 5]);
        assert.strictEqual(xg1b.oobEnd, 4, '右端越界：可追溯定位');
        assert.strictEqual(xg1b.text, '天命之謂', '只呈现越界前可见部分，不得把另一行文字当作其确定文字');
        const xg2b = rView.groups.find((g) => g.ord === 2).cells.find((c) => c.msId === rB.id);
        assert.deepStrictEqual([xg2b.lineNo, xg2b.startCp, xg2b.endCp, xg2b.text, xg2b.broken], [2, 1, 6, '率性之謂道', false]);
        // 原文视图一致：跨点片段在左行的覆盖区间被截到行长并标待修复
        const b1cov = rLines(rB.id).find((l) => l.lineNo === 1).covered;
        assert.deepStrictEqual(b1cov.map((c) => [c.startCp, c.endCp, c.broken]), [[0, 4, true]]);
        const b2cov = rLines(rB.id).find((l) => l.lineNo === 2).covered;
        assert.deepStrictEqual(b2cov.map((c) => [c.startCp, c.endCp, c.broken]), [[1, 6, false]]);
        // 发布门禁一致：有待修复不得发布
        r = await call(base, 'POST', `/documents/${dR}/publish`, { expectedVersion: rView.document.version });
        await expectFail(r, 409, '待修复');
        // 修复组1（乙改为缺文占位）后门禁放行，发布第 1 版
        r = await call(base, 'PUT', `/documents/${dR}/groups/${xg1.id}/repair`, {
            expectedVersion: rView.document.version,
            group: { ord: 1, fragments: [
                    { msId: rA.id, lineId: ra(1), startCp: 0, endCp: 5 },
                    { msId: rB.id, missing: true },
                ] },
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        rView = (await call(base, 'GET', `/documents/${dR}`)).json;
        assert.strictEqual(rView.stats.brokenCount, 0);
        r = await call(base, 'POST', `/documents/${dR}/publish`, { expectedVersion: rView.document.version });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        assert.strictEqual(r.json.editionNo, 1);
        rView = (await call(base, 'GET', `/documents/${dR}`)).json;
        const rEd1Version = rView.document.version;
        // 发布后再拆分（甲行4「君子之道」无片段）：已发布快照保持原样，版本对照仍可用
        rPrev = (await call(base, 'GET', `/documents/${dR}/reline/preview?op=split&lineId=${ra(4)}&splitCp=2`)).json;
        r = await call(base, 'POST', `/documents/${dR}/reline`, {
            expectedVersion: rPrev.version, op: 'split', lineId: ra(4), splitCp: 2, basis: rPrev.basis,
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        rView = (await call(base, 'GET', `/documents/${dR}`)).json;
        assert.deepStrictEqual(rLines(rA.id).map((l) => l.content), ['天命之謂性', '率性之謂道', '修道之謂教', '君子', '之道']);
        assert.strictEqual(rView.stats.brokenCount, 0);
        const rEd1 = (await call(base, 'GET', `/documents/${dR}/editions/1`)).json;
        assert.strictEqual(rEd1.view.document.version, rEd1Version, '快照版本号固化');
        assert.deepStrictEqual(rEd1.view.rawByMs.find((x) => x.msId === rA.id).lines.map((l) => l.content), ['天命之謂性', '率性之謂道', '修道之謂教', '君子之道'], '已发布快照保持原样');
        const rDiff = (await call(base, 'GET', `/documents/${dR}/editions/1/diff`)).json;
        assert.ok(rDiff.textChanges.some((t) => t.msId === rA.id), '拆分后版本对照可见行文变化');
        // ---------- 行界调整：合并相邻两行 ----------
        r = await call(base, 'POST', '/documents', { title: `行界合并测试 ${++seq}`, manuscripts: ['甲', '乙'] });
        assert.strictEqual(r.status, 201);
        const dM = r.json.id;
        let mView = (await call(base, 'GET', `/documents/${dM}`)).json;
        let mVer = mView.document.version;
        const [mA, mB] = mView.manuscripts;
        await call(base, 'POST', `/manuscripts/${mA.id}/lines`, { expectedVersion: mVer++, content: '天命之謂性' });
        await call(base, 'POST', `/manuscripts/${mA.id}/lines`, { expectedVersion: mVer++, content: '率性之謂道' });
        await call(base, 'POST', `/manuscripts/${mA.id}/lines`, { expectedVersion: mVer++, content: '修道之謂教' });
        await call(base, 'POST', `/manuscripts/${mB.id}/lines`, { expectedVersion: mVer++, content: '天命之謂姓' });
        await call(base, 'POST', `/manuscripts/${mB.id}/lines`, { expectedVersion: mVer++, content: '率性之謂道' });
        mView = (await call(base, 'GET', `/documents/${dM}`)).json;
        const mLines = (msId) => mView.rawByMs.find((x) => x.msId === msId).lines;
        const ma = (no) => mLines(mA.id).find((l) => l.lineNo === no).lineId;
        const mb = (no) => mLines(mB.id).find((l) => l.lineNo === no).lineId;
        r = await call(base, 'PUT', `/documents/${dM}/groups`, {
            expectedVersion: mView.document.version,
            groups: [
                { ord: 1, fragments: [
                        { msId: mA.id, lineId: ma(1), startCp: 0, endCp: 5 },
                        { msId: mB.id, lineId: mb(1), startCp: 0, endCp: 5 },
                    ] },
                { ord: 2, fragments: [
                        { msId: mA.id, lineId: ma(2), startCp: 0, endCp: 5 },
                        { msId: mB.id, lineId: mb(2), startCp: 0, endCp: 5 },
                    ] },
                { ord: 3, fragments: [
                        { msId: mA.id, lineId: ma(3), startCp: 0, endCp: 5 },
                        { msId: mB.id, missing: true },
                    ] },
            ],
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        // 发布第 1 版（供快照不可变校验）
        mView = (await call(base, 'GET', `/documents/${dM}`)).json;
        r = await call(base, 'POST', `/documents/${dM}/publish`, { expectedVersion: mView.document.version });
        assert.strictEqual(r.status, 201);
        mView = (await call(base, 'GET', `/documents/${dM}`)).json;
        const mEd1Version = mView.document.version;
        // 使组2 待修复：改甲行2 首字（与组2 底本片段相交）
        r = await call(base, 'PUT', `/lines/${ma(2)}`, { expectedVersion: mView.document.version, startCp: 0, endCp: 1, replacement: '帥' });
        assert.strictEqual(r.status, 200);
        mView = (await call(base, 'GET', `/documents/${dM}`)).json;
        assert.strictEqual(mView.groups.find((g) => g.ord === 2).broken, true);
        // 非相邻行 / 不同抄本 / 自身 / 不存在 / 他文献行 → 明确拒绝
        await expectFail(await call(base, 'GET', `/documents/${dM}/reline/preview?op=merge&leftLineId=${ma(1)}&rightLineId=${ma(3)}`), 400, '不相邻');
        await expectFail(await call(base, 'GET', `/documents/${dM}/reline/preview?op=merge&leftLineId=${ma(2)}&rightLineId=${ma(1)}`), 400, '不相邻');
        await expectFail(await call(base, 'GET', `/documents/${dM}/reline/preview?op=merge&leftLineId=${ma(1)}&rightLineId=${mb(1)}`), 400, '同一抄本');
        await expectFail(await call(base, 'GET', `/documents/${dM}/reline/preview?op=merge&leftLineId=${ma(1)}&rightLineId=${ma(1)}`), 400, '自身');
        await expectFail(await call(base, 'GET', `/documents/${dM}/reline/preview?op=merge&leftLineId=${ma(1)}&rightLineId=999999`), 404, '不存在');
        await expectFail(await call(base, 'GET', `/documents/${dM}/reline/preview?op=merge&leftLineId=${ma(1)}&rightLineId=${ra(1)}`), 400, '不属于本文献');
        // 预览合并 甲行1+行2：右行片段迁至左行；原已待修复组列入预览但不自动转完好
        mView = (await call(base, 'GET', `/documents/${dM}`)).json;
        let mVerBefore = mView.document.version;
        let mPrev = (await call(base, 'GET', `/documents/${dM}/reline/preview?op=merge&leftLineId=${ma(1)}&rightLineId=${ma(2)}`)).json;
        assert.strictEqual(mPrev.version, mVerBefore);
        assert.strictEqual(mPrev.op, 'merge');
        assert.deepStrictEqual(mPrev.basis, {
            leftLineId: ma(1), leftLineNo: 1, leftContent: '天命之謂性', leftLengthCp: 5,
            rightLineId: ma(2), rightLineNo: 2, rightContent: '帥性之謂道', rightLengthCp: 5,
        });
        assert.deepStrictEqual(mPrev.lines.map((l) => [l.lineNo, l.oldLineNo, l.content, l.origin]), [
            [1, 1, '天命之謂性帥性之謂道', 'merged'],
            [2, 3, '修道之謂教', 'shifted'],
        ]);
        const mf1 = mPrev.fragments.find((f) => f.groupOrd === 1);
        assert.strictEqual(mf1.status, 'unchanged');
        const mf2 = mPrev.fragments.find((f) => f.groupOrd === 2);
        assert.strictEqual(mf2.status, 'moved');
        assert.deepStrictEqual([mf2.newLineId, mf2.newLineNo, mf2.newStartCp, mf2.newEndCp], [ma(1), 1, 5, 10]);
        assert.strictEqual(mf2.groupAlreadyBroken, true);
        assert.strictEqual(mPrev.brokenGroups.length, 1);
        assert.strictEqual(mPrev.brokenGroups[0].newlyBroken, false, '原已待修复组列入预览但不自动转完好');
        // 预览只读
        assert.strictEqual((await call(base, 'GET', `/documents/${dM}`)).json.document.version, mVerBefore);
        // 提交合并：成功仅推进一次版本
        r = await call(base, 'POST', `/documents/${dM}/reline`, {
            expectedVersion: mVerBefore, op: 'merge', leftLineId: ma(1), rightLineId: ma(2), basis: mPrev.basis,
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert.strictEqual(r.json.version, mVerBefore + 1, '成功仅推进一次版本');
        mView = (await call(base, 'GET', `/documents/${dM}`)).json;
        assert.deepStrictEqual(mLines(mA.id).map((l) => [l.lineNo, l.content]), [
            [1, '天命之謂性帥性之謂道'], [2, '修道之謂教'],
        ]);
        const mg2 = mView.groups.find((g) => g.ord === 2);
        assert.strictEqual(mg2.broken, true, '原已待修复组合并后不得自动转完好');
        const mg2a = mg2.cells.find((c) => c.msId === mA.id);
        assert.deepStrictEqual([mg2a.lineNo, mg2a.startCp, mg2a.endCp, mg2a.text], [1, 5, 10, '帥性之謂道']);
        // 缺文标记不变；组3 底本片段行号顺移
        const mg3 = mView.groups.find((g) => g.ord === 3);
        assert.strictEqual(mg3.cells.find((c) => c.msId === mB.id).missing, true);
        assert.strictEqual(mg3.cells.find((c) => c.msId === mA.id).lineNo, 2);
        // 发布门禁一致：仍待修复 → 不得发布
        r = await call(base, 'POST', `/documents/${dM}/publish`, { expectedVersion: mView.document.version });
        await expectFail(r, 409, '待修复');
        // 过期版本 → 409 不推进；basis 不符 → 409 RELINE_STALE 不推进
        mView = (await call(base, 'GET', `/documents/${dM}`)).json;
        mVerBefore = mView.document.version;
        r = await call(base, 'POST', `/documents/${dM}/reline`, {
            expectedVersion: mVerBefore - 1, op: 'merge', leftLineId: mb(1), rightLineId: mb(2), basis: mPrev.basis,
        });
        await expectFail(r, 409, '版本已过期');
        mPrev = (await call(base, 'GET', `/documents/${dM}/reline/preview?op=merge&leftLineId=${mb(1)}&rightLineId=${mb(2)}`)).json;
        r = await call(base, 'POST', `/documents/${dM}/reline`, {
            expectedVersion: mVerBefore, op: 'merge', leftLineId: mb(1), rightLineId: mb(2),
            basis: { ...mPrev.basis, leftContent: '天命之謂性' },
        });
        await expectFail(r, 409, '已变化');
        assert.strictEqual(r.json.details.code, 'RELINE_STALE');
        assert.strictEqual((await call(base, 'GET', `/documents/${dM}`)).json.document.version, mVerBefore, '拒绝不推进版本');
        // 乙行1+行2 合并：右行片段迁至左行，完好组保持完好
        r = await call(base, 'POST', `/documents/${dM}/reline`, {
            expectedVersion: mVerBefore, op: 'merge', leftLineId: mb(1), rightLineId: mb(2), basis: mPrev.basis,
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        mView = (await call(base, 'GET', `/documents/${dM}`)).json;
        assert.deepStrictEqual(mLines(mB.id).map((l) => [l.lineNo, l.content]), [[1, '天命之謂姓率性之謂道']]);
        const mg1b = mView.groups.find((g) => g.ord === 1).cells.find((c) => c.msId === mB.id);
        assert.deepStrictEqual([mg1b.lineNo, mg1b.startCp, mg1b.endCp, mg1b.text], [1, 0, 5, '天命之謂姓']);
        const mg2b = mView.groups.find((g) => g.ord === 2).cells.find((c) => c.msId === mB.id);
        assert.deepStrictEqual([mg2b.lineNo, mg2b.startCp, mg2b.endCp, mg2b.text], [1, 5, 10, '率性之謂道']);
        // 修复组2 → 发布门禁放行；已发布快照保持原样
        r = await call(base, 'PUT', `/documents/${dM}/groups/${mg2.id}/repair`, {
            expectedVersion: mView.document.version,
            group: { ord: 2, fragments: [
                    { msId: mA.id, lineId: ma(1), startCp: 5, endCp: 10 },
                    { msId: mB.id, lineId: mb(1), startCp: 5, endCp: 10 },
                ] },
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        mView = (await call(base, 'GET', `/documents/${dM}`)).json;
        assert.strictEqual(mView.stats.brokenCount, 0);
        r = await call(base, 'POST', `/documents/${dM}/publish`, { expectedVersion: mView.document.version });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        assert.strictEqual(r.json.editionNo, 2);
        const mEd1 = (await call(base, 'GET', `/documents/${dM}/editions/1`)).json;
        assert.strictEqual(mEd1.view.document.version, mEd1Version, '快照版本号固化');
        assert.deepStrictEqual(mEd1.view.rawByMs.find((x) => x.msId === mA.id).lines.map((l) => l.content), ['天命之謂性', '率性之謂道', '修道之謂教'], '已发布快照保持原样');
        assert.strictEqual(mEd1.view.stats.brokenCount, 0);
        // ---------- 恢复已发布校勘版 ----------
        // 独立文献：两次发布，恢复到第 1 版；覆盖抄本增删改名/顺序、底本切换、行增删改、组重存
        r = await call(base, 'POST', '/documents', { title: `恢复测试 ${++seq}`, manuscripts: ['甲本', '乙本'] });
        assert.strictEqual(r.status, 201);
        const dX = r.json.id;
        let xView = (await call(base, 'GET', `/documents/${dX}`)).json;
        let xVer = xView.document.version;
        const xA0 = xView.manuscripts.find((m) => m.name === '甲本');
        const xB0 = xView.manuscripts.find((m) => m.name === '乙本');
        await call(base, 'POST', `/manuscripts/${xA0.id}/lines`, { expectedVersion: xVer++, content: '天命之謂性' });
        await call(base, 'POST', `/manuscripts/${xA0.id}/lines`, { expectedVersion: xVer++, content: '率性之謂道' });
        await call(base, 'POST', `/manuscripts/${xB0.id}/lines`, { expectedVersion: xVer++, content: '天命之謂姓' });
        await call(base, 'POST', `/manuscripts/${xB0.id}/lines`, { expectedVersion: xVer++, content: '率性之謂道' });
        xView = (await call(base, 'GET', `/documents/${dX}`)).json;
        const xl = (msId, no) => xView.rawByMs.find((x) => x.msId === msId).lines.find((l) => l.lineNo === no).lineId;
        const xGroupsV1 = [
            { ord: 1, fragments: [
                    { msId: xA0.id, lineId: xl(xA0.id, 1), startCp: 0, endCp: 5 },
                    { msId: xB0.id, lineId: xl(xB0.id, 1), startCp: 0, endCp: 5 },
                ] },
            { ord: 2, fragments: [
                    { msId: xA0.id, lineId: xl(xA0.id, 2), startCp: 0, endCp: 5 },
                    { msId: xB0.id, missing: true },
                ] },
        ];
        r = await call(base, 'PUT', `/documents/${dX}/groups`, { expectedVersion: xView.document.version, groups: xGroupsV1 });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        xView = (await call(base, 'GET', `/documents/${dX}`)).json;
        r = await call(base, 'POST', `/documents/${dX}/publish`, { expectedVersion: xView.document.version });
        assert.strictEqual(r.status, 201);
        assert.strictEqual(r.json.editionNo, 1);
        xView = (await call(base, 'GET', `/documents/${dX}`)).json;
        const xEd1Version = xView.document.version;
        const xEd1Snapshot = (await call(base, 'GET', `/documents/${dX}/editions/1`)).json.view;
        // 工作版继续大幅修改：新增抄本丙、乙本改名、新增行、改字、整批重存换组 ID、切底本后再切回并发布第 2 版
        r = await call(base, 'POST', `/documents/${dX}/manuscripts`, { expectedVersion: xEd1Version, name: '丙本' });
        assert.strictEqual(r.status, 201);
        xView = (await call(base, 'GET', `/documents/${dX}`)).json;
        const xCid = xView.manuscripts.find((m) => m.name === '丙本').id;
        // 乙本改名：无改名接口，借助“恢复改名”验证；直接改库不合适——改用新增行 + 改字 + 重存组表达工作版差异
        r = await call(base, 'POST', `/manuscripts/${xCid}/lines`, { expectedVersion: xView.document.version, content: '完全不同的新文字XYZ' });
        assert.strictEqual(r.status, 201);
        xView = (await call(base, 'GET', `/documents/${dX}`)).json;
        const xa1now = xView.rawByMs.find((x) => x.msId === xA0.id).lines[0].lineId;
        r = await call(base, 'PUT', `/lines/${xa1now}`, {
            expectedVersion: xView.document.version, startCp: 0, endCp: 1, replacement: '丼',
        }); // 甲行1 首字改 → 两组中组1待修复
        assert.strictEqual(r.status, 200);
        xView = (await call(base, 'GET', `/documents/${dX}`)).json;
        // 修复组1（甲新文字 / 乙随新行内区间重录），让第 2 版可发布
        const xa2now = xView.rawByMs.find((x) => x.msId === xA0.id).lines[1].lineId;
        const xb1now = xView.rawByMs.find((x) => x.msId === xB0.id).lines[0].lineId;
        const xGroupsV2 = [
            { ord: 1, fragments: [
                    { msId: xA0.id, lineId: xa1now, startCp: 0, endCp: 5 },
                    { msId: xB0.id, lineId: xb1now, startCp: 0, endCp: 5 },
                ] },
            { ord: 2, fragments: [
                    { msId: xA0.id, lineId: xa2now, startCp: 0, endCp: 5 },
                    { msId: xB0.id, missing: true },
                    { msId: xCid, missing: true },
                ] },
        ];
        r = await call(base, 'PUT', `/documents/${dX}/groups`, { expectedVersion: xView.document.version, groups: xGroupsV2 });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        xView = (await call(base, 'GET', `/documents/${dX}`)).json;
        assert.strictEqual(xView.stats.brokenCount, 0);
        r = await call(base, 'POST', `/documents/${dX}/publish`, { expectedVersion: xView.document.version });
        assert.strictEqual(r.status, 201);
        assert.strictEqual(r.json.editionNo, 2);
        xView = (await call(base, 'GET', `/documents/${dX}`)).json;
        const xVerBeforeRestore = xView.document.version;
        assert.ok(xVerBeforeRestore > xEd1Version);
        // 恢复前：工作版 3 份抄本、组 2 组含丙缺文、甲行1首字为「丼」
        assert.strictEqual(xView.manuscripts.length, 3);
        assert.strictEqual(xView.rawByMs.find((x) => x.msId === xA0.id).lines[0].content[0], '丼');
        assert.strictEqual(xView.groups.find((g) => g.ord === 2).cells.length, 3);
        // —— 拒绝类（先于成功，验证不写入、不推进版本）——
        // 缺 expectedVersion → 400
        r = await call(base, 'POST', `/documents/${dX}/editions/1/restore`, {});
        await expectFail(r, 400, 'expectedVersion');
        // 版本已变化（对照的是 v1，现已到更后版本）→ 409，拒绝且不改动
        r = await call(base, 'POST', `/documents/${dX}/editions/1/restore`, { expectedVersion: xEd1Version });
        await expectFail(r, 409, '版本已过期');
        // 目标版不存在 → 404，拒绝且不改动
        r = await call(base, 'POST', `/documents/${dX}/editions/99/restore`, { expectedVersion: xVerBeforeRestore });
        await expectFail(r, 404, '不存在');
        // 非法版号 → 400
        r = await call(base, 'POST', `/documents/${dX}/editions/0/restore`, { expectedVersion: xVerBeforeRestore });
        await expectFail(r, 400, '正整数');
        // 以上拒绝均不推进版本
        xView = (await call(base, 'GET', `/documents/${dX}`)).json;
        assert.strictEqual(xView.document.version, xVerBeforeRestore, '拒绝恢复不得推进版本');
        assert.strictEqual(xView.manuscripts.length, 3, '拒绝恢复不得改动数据');
        // —— 成功恢复到第 1 版（携带对照时的 expectedVersion = 当前工作版版本号）——
        r = await call(base, 'POST', `/documents/${dX}/editions/1/restore`, { expectedVersion: xVerBeforeRestore });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert.strictEqual(r.json.ok, true);
        assert.strictEqual(r.json.editionNo, 1);
        assert.strictEqual(r.json.version, xVerBeforeRestore + 1, '成功后版本号只前进一次');
        assert.deepStrictEqual(r.json.restored, {
            manuscriptCount: 2, lineCount: 4, groupCount: 2, fragmentCount: 4, missingCount: 1,
            baseMsId: xA0.id,
        });
        xView = (await call(base, 'GET', `/documents/${dX}`)).json;
        const xVerAfterRestore = xView.document.version;
        assert.strictEqual(xVerAfterRestore, xVerBeforeRestore + 1);
        // 抄本及顺序恢复为 2 份（后增的丙本被移除），甲/乙沿用快照中的稳定身份 id
        assert.strictEqual(xView.manuscripts.length, 2);
        assert.deepStrictEqual(xView.manuscripts.map((m) => [m.id, m.name, m.position]), [
            [xA0.id, '甲本', 1], [xB0.id, '乙本', 2],
        ]);
        assert.strictEqual(xView.document.baseMsId, xA0.id, '底本恢复');
        // 全部原始行恢复
        assert.deepStrictEqual(xView.rawByMs.find((x) => x.msId === xA0.id).lines.map((l) => [l.lineNo, l.content]), [[1, '天命之謂性'], [2, '率性之謂道']]);
        assert.deepStrictEqual(xView.rawByMs.find((x) => x.msId === xB0.id).lines.map((l) => [l.lineNo, l.content]), [[1, '天命之謂姓'], [2, '率性之謂道']]);
        // 对应组、异文与缺文恢复
        assert.strictEqual(xView.stats.groupCount, 2);
        assert.strictEqual(xView.stats.brokenCount, 0, '恢复后无待修复组');
        const rg1 = xView.groups.find((g) => g.ord === 1);
        const rg2 = xView.groups.find((g) => g.ord === 2);
        assert.strictEqual(rg1.variant, true, '性/姓异文恢复');
        assert.strictEqual(rg1.baseText, '天命之謂性');
        assert.strictEqual(rg2.hasMissing, true, '乙本缺文标记恢复');
        assert.strictEqual(rg2.cells.find((c) => c.msId === xB0.id).missing, true);
        assert.strictEqual(rg2.cells.length, 2, '丙本随抄本移除而消失');
        // 重建后的行与组取得“当前有效标识”：新组 id 不等于快照旧 id；用新 id 走修复/删除/改字接口可用
        const snapshotGroupId = xEd1Snapshot.groups.find((g) => g.ord === 1).id;
        assert.notStrictEqual(rg1.id, snapshotGroupId, '重建组取得新 id');
        const newA1 = xView.rawByMs.find((x) => x.msId === xA0.id).lines[0].lineId;
        assert.notStrictEqual(newA1, xEd1Snapshot.rawByMs.find((x) => x.msId === xA0.id).lines[0].lineId);
        // 标题 / 已发布版编号 / 快照保持原样
        assert.strictEqual(xView.document.title, `恢复测试 ${seq}`);
        assert.strictEqual(xView.document.publishedVer, 2, '已发布版编号不变');
        const ed2still = await call(base, 'GET', `/documents/${dX}/editions/2`);
        assert.strictEqual(ed2still.status, 200, '第 2 版快照仍在');
        assert.strictEqual((await call(base, 'GET', `/documents/${dX}/editions/1`)).json.view.groups.length, 2, '第 1 版快照原样');
        // 恢复后对照：第 1 版与当前工作版应完全一致（无任何变化）
        let xDiff = (await call(base, 'GET', `/documents/${dX}/editions/1/diff`)).json;
        assert.strictEqual(xDiff.textChanges.length, 0, '恢复后行文与第 1 版无差异');
        assert.strictEqual(xDiff.groupDiff.counts.paired, 2);
        assert.strictEqual(xDiff.groupDiff.counts.unpairedOld, 0);
        assert.strictEqual(xDiff.groupDiff.counts.unpairedNew, 0);
        assert.ok(xDiff.groupDiff.paired.every((p) => p.status === 'same'), '配对组全部无变化');
        // 恢复后现有流程仍可用：改字 → 待修复 → 修复 → 整批重存 → 行界 → 发布第 3 版
        r = await call(base, 'PUT', `/lines/${newA1}`, {
            expectedVersion: xVerAfterRestore, startCp: 0, endCp: 1, replacement: '天',
        }); // 同字替换，不相交语义：与组1片段相交但文字不变
        assert.strictEqual(r.status, 200);
        xView = (await call(base, 'GET', `/documents/${dX}`)).json;
        assert.strictEqual(xView.groups.find((g) => g.ord === 1).broken, true, '改字接口对新行/新组有效');
        const newG1 = xView.groups.find((g) => g.ord === 1).id;
        const newB1 = xView.rawByMs.find((x) => x.msId === xB0.id).lines[0].lineId;
        const newA2 = xView.rawByMs.find((x) => x.msId === xA0.id).lines[1].lineId;
        r = await call(base, 'PUT', `/documents/${dX}/groups/${newG1}/repair`, {
            expectedVersion: xView.document.version,
            group: { ord: 1, fragments: [
                    { msId: xA0.id, lineId: newA1, startCp: 0, endCp: 5 },
                    { msId: xB0.id, lineId: newB1, startCp: 0, endCp: 5 },
                ] },
        });
        assert.strictEqual(r.status, 200, `修复接口对重建组可用：${JSON.stringify(r.json)}`);
        xView = (await call(base, 'GET', `/documents/${dX}`)).json;
        assert.strictEqual(xView.stats.brokenCount, 0);
        // 行界调整在重建行上可用
        let xPrev = (await call(base, 'GET', `/documents/${dX}/reline/preview?op=split&lineId=${newA2}&splitCp=2`)).json;
        r = await call(base, 'POST', `/documents/${dX}/reline`, {
            expectedVersion: xView.document.version, op: 'split', lineId: newA2, splitCp: 2, basis: xPrev.basis,
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        xView = (await call(base, 'GET', `/documents/${dX}`)).json;
        // 补配接口仍可用（只读预览）
        r = await call(base, 'GET', `/documents/${dX}/supplement/preview?targetMsId=${xB0.id}`);
        assert.strictEqual(r.status, 200);
        // 版本对照接口在恢复后仍可用
        xDiff = (await call(base, 'GET', `/documents/${dX}/editions/1/diff`)).json;
        assert.ok(xDiff.textChanges.some((t) => t.status === 'changed' || t.status === 'added'), '拆分后对照可见变化');
        // 合并回去以重新发布：先修复拆分造成的组2待修复
        xView = (await call(base, 'GET', `/documents/${dX}`)).json;
        if (xView.stats.brokenCount > 0) {
            const splitLines = xView.rawByMs.find((x) => x.msId === xA0.id).lines;
            for (const g of xView.groups.filter((g) => g.broken)) {
                const rebuild = [];
                for (const ms of xView.manuscripts) {
                    const cell = g.cells.find((c) => c.msId === ms.id);
                    if (!cell)
                        continue;
                    if (cell.missing)
                        rebuild.push({ msId: ms.id, missing: true });
                    else {
                        const ln = splitLines.find((l) => l.lineNo === cell.lineNo);
                        // 跨拆分点片段修复为该新行内尚可见的确定部分
                        const len = Array.from(ln.content).length;
                        const s = Math.min(cell.startCp ?? 0, len);
                        const e = Math.min(cell.endCp ?? len, len);
                        if (e > s)
                            rebuild.push({ msId: ms.id, lineId: ln.lineId, startCp: s, endCp: e });
                    }
                }
                const rr = await call(base, 'PUT', `/documents/${dX}/groups/${g.id}/repair`, {
                    expectedVersion: xView.document.version, group: { ord: g.ord, fragments: rebuild },
                });
                assert.strictEqual(rr.status, 200, JSON.stringify(rr.json));
                xView = (await call(base, 'GET', `/documents/${dX}`)).json;
            }
        }
        r = await call(base, 'POST', `/documents/${dX}/publish`, { expectedVersion: xView.document.version });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        assert.strictEqual(r.json.editionNo, 3, '恢复后继续发布得到第 3 版');
        // 恢复后新增抄本：序列已推进，插入取得有效不冲突 id，现有流程完整可用
        xView = (await call(base, 'GET', `/documents/${dX}`)).json;
        r = await call(base, 'POST', `/documents/${dX}/manuscripts`, { expectedVersion: xView.document.version, name: '丁本' });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        xView = (await call(base, 'GET', `/documents/${dX}`)).json;
        const xDid = xView.manuscripts.find((m) => m.name === '丁本').id;
        assert.ok(xDid > 0 && !xView.manuscripts.some((m) => m.id === xDid && m.name !== '丁本'));
        // —— 快照损坏（无法构成合法归组）→ 409 RESTORE_SNAPSHOT_INVALID，整体拒绝、不改动、不推进 ——
        // 另建文献发布第 1 版后，直接把该版快照里组1的乙本片段改成越界区间（模拟半损坏快照）
        r = await call(base, 'POST', '/documents', { title: `损坏快照测试 ${++seq}`, manuscripts: ['甲', '乙'] });
        assert.strictEqual(r.status, 201);
        const dC = r.json.id;
        let cView = (await call(base, 'GET', `/documents/${dC}`)).json;
        const [cA, cB] = cView.manuscripts;
        await call(base, 'POST', `/manuscripts/${cA.id}/lines`, { expectedVersion: cView.document.version, content: 'ABC' });
        cView = (await call(base, 'GET', `/documents/${dC}`)).json;
        await call(base, 'POST', `/manuscripts/${cB.id}/lines`, { expectedVersion: cView.document.version, content: 'ABC' });
        cView = (await call(base, 'GET', `/documents/${dC}`)).json;
        const ca1 = cView.rawByMs.find((x) => x.msId === cA.id).lines[0].lineId;
        const cb1 = cView.rawByMs.find((x) => x.msId === cB.id).lines[0].lineId;
        r = await call(base, 'PUT', `/documents/${dC}/groups`, {
            expectedVersion: cView.document.version,
            groups: [{ ord: 1, fragments: [
                        { msId: cA.id, lineId: ca1, startCp: 0, endCp: 3 },
                        { msId: cB.id, lineId: cb1, startCp: 0, endCp: 3 },
                    ] }],
        });
        assert.strictEqual(r.status, 200);
        cView = (await call(base, 'GET', `/documents/${dC}`)).json;
        r = await call(base, 'POST', `/documents/${dC}/publish`, { expectedVersion: cView.document.version });
        assert.strictEqual(r.status, 201);
        cView = (await call(base, 'GET', `/documents/${dC}`)).json;
        const cVer = cView.document.version;
        // 先做一次工作版改动，使恢复有意义且版本推进
        r = await call(base, 'POST', `/manuscripts/${cB.id}/lines`, { expectedVersion: cVer, content: 'EXTRA' });
        assert.strictEqual(r.status, 201);
        cView = (await call(base, 'GET', `/documents/${dC}`)).json;
        const cVerNow = cView.document.version;
        // 篡改第 1 版快照 JSONB：把唯一一组的底本片段区间改成越界 [0,99)
        const { rows: edRows } = await (0, db_1.query)('SELECT edition_no FROM editions WHERE doc_id=$1 ORDER BY edition_no', [dC]);
        assert.strictEqual(edRows.length, 1);
        await (0, db_1.query)(`UPDATE editions SET snapshot = jsonb_set(snapshot, '{groups,0,cells,0,endCp}', '99'::jsonb)
       WHERE doc_id=$1 AND edition_no=1`, [dC]);
        const cLinesBefore = (await call(base, 'GET', `/documents/${dC}`)).json.stats.lineCount;
        r = await call(base, 'POST', `/documents/${dC}/editions/1/restore`, { expectedVersion: cVerNow });
        await expectFail(r, 409, '无法构成合法归组');
        assert.strictEqual(r.json.details.code, 'RESTORE_SNAPSHOT_INVALID');
        assert.ok(Array.isArray(r.json.details.issues) && r.json.details.issues.length > 0);
        assert.ok(JSON.stringify(r.json.details.issues).includes('越界'), '须说明越界原因');
        // 整体拒绝：版本不推进、工作版数据不变
        cView = (await call(base, 'GET', `/documents/${dC}`)).json;
        assert.strictEqual(cView.document.version, cVerNow, '损坏快照拒绝后不得推进版本');
        assert.strictEqual(cView.stats.lineCount, cLinesBefore, '损坏快照拒绝后不得改动数据');
        // ========== 批量行改：一次校订同一文献多份抄本的多份原始行 ==========
        r = await call(base, 'POST', '/documents', { title: `批量行改测试 ${++seq}`, manuscripts: ['甲', '乙', '丙'] });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        const dBE = r.json.id;
        let beView = (await call(base, 'GET', `/documents/${dBE}`)).json;
        const [beA, beB, beC] = beView.manuscripts;
        // 甲：行1 0123456789 / 行2 ABCDE
        // 乙：行1 0123456789 / 行2 ABCDE（组2 对乙显式缺文）
        // 丙：行1 0123456789 / 行2 ABCDE
        let beV = beView.document.version;
        for (const [ms, text] of [
            [beA.id, '0123456789'], [beB.id, '0123456789'], [beC.id, '0123456789'],
            [beA.id, 'ABCDE'], [beB.id, 'ABCDE'], [beC.id, 'ABCDE'],
        ]) {
            r = await call(base, 'POST', `/manuscripts/${ms}/lines`, { expectedVersion: beV, content: text });
            assert.strictEqual(r.status, 201, JSON.stringify(r.json));
            beV++;
        }
        beView = (await call(base, 'GET', `/documents/${dBE}`)).json;
        const beLine = (msId, no) => beView.rawByMs.find((x) => x.msId === msId).lines[no - 1].lineId;
        const beA1 = beLine(beA.id, 1), beA2 = beLine(beA.id, 2);
        const beB1 = beLine(beB.id, 1), beB2 = beLine(beB.id, 2);
        const beC1 = beLine(beC.id, 1), beC2 = beLine(beC.id, 2);
        // 组1：三抄本行1 [0,3)；组2：甲 [3,6)、乙缺文、丙 [3,6)；组3：三抄本行2 [1,4)
        r = await call(base, 'PUT', `/documents/${dBE}/groups`, {
            expectedVersion: beView.document.version,
            groups: [
                { ord: 1, fragments: [
                        { msId: beA.id, lineId: beA1, startCp: 0, endCp: 3 },
                        { msId: beB.id, lineId: beB1, startCp: 0, endCp: 3 },
                        { msId: beC.id, lineId: beC1, startCp: 0, endCp: 3 },
                    ] },
                { ord: 2, fragments: [
                        { msId: beA.id, lineId: beA1, startCp: 3, endCp: 6 },
                        { msId: beB.id, missing: true },
                        { msId: beC.id, lineId: beC1, startCp: 3, endCp: 6 },
                    ] },
                { ord: 3, fragments: [
                        { msId: beA.id, lineId: beA2, startCp: 1, endCp: 4 },
                        { msId: beB.id, lineId: beB2, startCp: 1, endCp: 4 },
                        { msId: beC.id, lineId: beC2, startCp: 1, endCp: 4 },
                    ] },
            ],
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        beView = (await call(base, 'GET', `/documents/${dBE}`)).json;
        const beVerAfterGroups = beView.document.version;
        // ---- 预览：同一行多个不相交编辑按原坐标同时生效 + 跨抄本累计位移，无待修复 ----
        // 甲行1「0123456789」：在点 0 与点 3 各插入一个字（均为原坐标）
        //   组1 [0,3)：点0 在其起点（边界，片段在其后→平移）；点3 在其终点（边界，不后续）⇒ [1,4)
        //   组2 [3,6)：两个点都位于其起点或之前（边界只平移后续片段）→ 累计 +2 ⇒ [5,8)
        // 丙行1：[6,7) 删除（长度-1）：组2 [3,6) 与删除区间端点相接 → 不动
        // 乙行2：[4,4) 插入「Q」：组3 [1,4) 的插入点在其右端点（边界）→ 不平移
        let bep = (await call(base, 'POST', `/documents/${dBE}/lines/batch-edit/preview`, {
            edits: [
                { lineId: beA1, startCp: 0, endCp: 0, replacement: 'X' },
                { lineId: beA1, startCp: 3, endCp: 3, replacement: 'W' },
                { lineId: beC1, startCp: 6, endCp: 7, replacement: '' },
                { lineId: beB2, startCp: 4, endCp: 4, replacement: 'Q' },
            ],
        })).json;
        assert.strictEqual(bep.documentId, dBE);
        assert.strictEqual(bep.version, beVerAfterGroups, '预览只读，不推进版本');
        assert.strictEqual(bep.editCount, 4);
        assert.strictEqual(bep.lines.length, 3);
        const prevA1 = bep.lines.find((l) => l.lineId === beA1);
        assert.strictEqual(prevA1.oldContent, '0123456789');
        assert.strictEqual(prevA1.newContent, 'X012W3456789', `按原坐标同时生效，实际：${prevA1.newContent}`);
        assert.strictEqual(prevA1.newLengthCp, 12);
        const prevC1 = bep.lines.find((l) => l.lineId === beC1);
        assert.strictEqual(prevC1.newContent, '012345789');
        const prevB2 = bep.lines.find((l) => l.lineId === beB2);
        assert.strictEqual(prevB2.newContent, 'ABCDQE');
        assert.strictEqual(bep.brokenGroups.length, 0, '全部为端点相接 / 不相交平移，无待修复组');
        const fA1g1 = bep.fragments.find((f) => f.lineId === beA1 && f.groupOrd === 1);
        assert.strictEqual(fA1g1.status, 'moved');
        assert.deepStrictEqual([fA1g1.newStartCp, fA1g1.newEndCp], [1, 4]);
        const fA1g2 = bep.fragments.find((f) => f.lineId === beA1 && f.groupOrd === 2);
        assert.deepStrictEqual([fA1g2.newStartCp, fA1g2.newEndCp], [5, 8], '两个插入点都在片段起点/之前，累计位移 +2');
        const fC1g2 = bep.fragments.find((f) => f.lineId === beC1 && f.groupOrd === 2);
        assert.strictEqual(fC1g2.status, 'unchanged', '删除点 6 与片段右端点相接，不平移');
        const fB2g3 = bep.fragments.find((f) => f.lineId === beB2 && f.groupOrd === 3);
        assert.strictEqual(fB2g3.status, 'unchanged', '插入点位于片段边界（右端点），不平移该片段');
        assert.ok(Array.isArray(bep.basis) && bep.basis.length === 3);
        // 再次查看确认预览只读
        beView = (await call(base, 'GET', `/documents/${dBE}`)).json;
        assert.strictEqual(beView.document.version, beVerAfterGroups);
        // ---- 提交：携带 expectedVersion + basis；成功只推进一次版本 ----
        r = await call(base, 'POST', `/documents/${dBE}/lines/batch-edit`, {
            expectedVersion: beVerAfterGroups,
            edits: [
                { lineId: beA1, startCp: 0, endCp: 0, replacement: 'X' },
                { lineId: beA1, startCp: 3, endCp: 3, replacement: 'W' },
                { lineId: beC1, startCp: 6, endCp: 7, replacement: '' },
                { lineId: beB2, startCp: 4, endCp: 4, replacement: 'Q' },
            ],
            basis: bep.basis,
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert.strictEqual(r.json.version, beVerAfterGroups + 1, '成功只推进一次版本');
        assert.strictEqual(r.json.result.lines.find((l) => l.lineId === beA1).newContent, 'X012W3456789');
        beView = (await call(base, 'GET', `/documents/${dBE}`)).json;
        assert.strictEqual(beView.stats.brokenCount, 0);
        const afterA1g1 = beView.groups.find((g) => g.ord === 1).cells.find((c) => c.msId === beA.id);
        assert.strictEqual(afterA1g1.text, '012', '平移后截取文字不变');
        const afterA1g2 = beView.groups.find((g) => g.ord === 2).cells.find((c) => c.msId === beA.id);
        assert.strictEqual(afterA1g2.text, '345', '累计位移后 [5,8) 仍截取原片段文字 345');
        // 组2 乙仍显式缺文，缺文状态不被改动
        const afterG2B = beView.groups.find((g) => g.ord === 2).cells.find((c) => c.msId === beB.id);
        assert.strictEqual(afterG2B.missing, true, '缺文标记不依附行，批量行改不得改动缺文');
        // ---- 插入点严格位于片段内部 → 组待修复（边界只平移）----
        beView = (await call(base, 'GET', `/documents/${dBE}`)).json;
        const vForInsert = beView.document.version;
        // 当前乙行1 仍为 0123456789；组1 乙片段 [0,3)。在点 1（严格内部）插「中」→ 组1 待修复
        bep = (await call(base, 'POST', `/documents/${dBE}/lines/batch-edit/preview`, {
            edits: [{ lineId: beB1, startCp: 1, endCp: 1, replacement: '中' }],
        })).json;
        assert.strictEqual(bep.brokenGroups.length, 1);
        assert.strictEqual(bep.brokenGroups[0].groupId, beView.groups.find((g) => g.ord === 1).id);
        assert.strictEqual(bep.brokenGroups[0].newlyBroken, true);
        const bf = bep.fragments.find((f) => f.lineId === beB1 && f.groupOrd === 1);
        assert.strictEqual(bf.status, 'broken');
        assert.deepStrictEqual([bf.newStartCp, bf.newEndCp], [0, 3], '相交片段保留原区间坐标可追溯');
        r = await call(base, 'POST', `/documents/${dBE}/lines/batch-edit`, {
            expectedVersion: vForInsert,
            edits: [{ lineId: beB1, startCp: 1, endCp: 1, replacement: '中' }],
            basis: bep.basis,
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        beView = (await call(base, 'GET', `/documents/${dBE}`)).json;
        assert.strictEqual(beView.stats.brokenCount, 1);
        // 待修复期间不得发布
        r = await call(base, 'POST', `/documents/${dBE}/publish`, { expectedVersion: beView.document.version });
        await expectFail(r, 409, '待修复');
        // ---- 原已待修复组不得自动改好：对乙行1做不相交的平移编辑，组1 仍待修复 ----
        // 乙行1 现在「0中123456789」（11 字）；组1 [0,3) 保留原坐标（覆盖 0中1）。
        // 在点 11（行尾）插入不与片段相交 → 组1 在 brokenGroups 中但 newlyBroken=false
        bep = (await call(base, 'POST', `/documents/${dBE}/lines/batch-edit/preview`, {
            edits: [{ lineId: beB1, startCp: 11, endCp: 11, replacement: '尾' }],
        })).json;
        const stillBroken = bep.brokenGroups.find((g) => g.ord === 1);
        assert.ok(stillBroken, '原已待修复组仍须列出');
        assert.strictEqual(stillBroken.newlyBroken, false, '原已待修复不得自动转好');
        const stillFrag = bep.fragments.find((f) => f.lineId === beB1 && f.groupOrd === 1);
        assert.strictEqual(stillFrag.groupAlreadyBroken, true, '片段仍标记为原组已待修复');
        assert.ok(stillFrag.status === 'broken' || stillFrag.status === 'unchanged', '片段坐标保留 / 不动');
        // ---- 缩行致片段越界 → 组待修复（相交改动保留原坐标，读模型中呈越界）----
        // 先修复组1，便于干净验证越界路径
        beView = (await call(base, 'GET', `/documents/${dBE}`)).json;
        const g1Id = beView.groups.find((g) => g.ord === 1).id;
        r = await call(base, 'PUT', `/documents/${dBE}/groups/${g1Id}/repair`, {
            expectedVersion: beView.document.version,
            group: { ord: 1, fragments: [
                    { msId: beA.id, lineId: beA1, startCp: 1, endCp: 4 },
                    { msId: beB.id, lineId: beB1, startCp: 0, endCp: 3 },
                    { msId: beC.id, lineId: beC1, startCp: 0, endCp: 3 },
                ] },
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        beView = (await call(base, 'GET', `/documents/${dBE}`)).json;
        assert.strictEqual(beView.stats.brokenCount, 0);
        // 丙行2 仍为 ABCDE，组3 丙片段 [1,4)=BCD；删除 [2,5) 与片段相交且缩短行 → 组3 待修复，
        // 原区间 [1,4) 保留（右端越出新行长 2）以便追溯。
        bep = (await call(base, 'POST', `/documents/${dBE}/lines/batch-edit/preview`, {
            edits: [{ lineId: beC2, startCp: 2, endCp: 5, replacement: '' }],
        })).json;
        assert.strictEqual(bep.lines.find((l) => l.lineId === beC2).newContent, 'AB');
        const oob = bep.fragments.find((f) => f.lineId === beC2 && f.groupOrd === 3);
        assert.strictEqual(oob.status, 'broken');
        assert.deepStrictEqual([oob.newStartCp, oob.newEndCp], [1, 4], '相交改动保留原区间坐标');
        assert.strictEqual(bep.brokenGroups.find((g) => g.ord === 3).newlyBroken, true);
        // ---- 冲突 / 非法编辑整批报错并定位 ----
        // 区间重叠
        r = await call(base, 'POST', `/documents/${dBE}/lines/batch-edit/preview`, {
            edits: [
                { lineId: beA2, startCp: 0, endCp: 3, replacement: 'xxx' },
                { lineId: beA2, startCp: 2, endCp: 4, replacement: 'yy' },
            ],
        });
        await expectFail(r, 400, '重叠');
        assert.ok(r.json.details.some((d) => d.code === 'OVERLAPPING_RANGES' && d.lineId === beA2));
        // 同点重复插入
        r = await call(base, 'POST', `/documents/${dBE}/lines/batch-edit/preview`, {
            edits: [
                { lineId: beA2, startCp: 1, endCp: 1, replacement: '甲' },
                { lineId: beA2, startCp: 1, endCp: 1, replacement: '乙' },
            ],
        });
        await expectFail(r, 400, '重复插入');
        assert.ok(r.json.details.some((d) => d.code === 'DUPLICATE_INSERTION'));
        // 插入点落在其他编辑区间内部
        r = await call(base, 'POST', `/documents/${dBE}/lines/batch-edit/preview`, {
            edits: [
                { lineId: beA2, startCp: 0, endCp: 3, replacement: 'xyz' },
                { lineId: beA2, startCp: 2, endCp: 2, replacement: '内' },
            ],
        });
        await expectFail(r, 400, '插入点');
        assert.ok(r.json.details.some((d) => d.code === 'INSERTION_POINT_IN_INTERVAL'));
        // 插入点落在其他编辑区间端点（同样拒绝）
        r = await call(base, 'POST', `/documents/${dBE}/lines/batch-edit/preview`, {
            edits: [
                { lineId: beA2, startCp: 0, endCp: 3, replacement: 'xyz' },
                { lineId: beA2, startCp: 3, endCp: 3, replacement: '端' },
            ],
        });
        await expectFail(r, 400, '端点');
        assert.ok(r.json.details.some((d) => d.code === 'INSERTION_POINT_IN_INTERVAL'));
        // 非零长编辑端点相接允许（[0,3) 与 [3,5)）
        r = await call(base, 'POST', `/documents/${dBE}/lines/batch-edit/preview`, {
            edits: [
                { lineId: beA2, startCp: 0, endCp: 3, replacement: 'XYZ' },
                { lineId: beA2, startCp: 3, endCp: 5, replacement: 'DE' },
            ],
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert.strictEqual(r.json.lines[0].newContent, 'XYZDE');
        // 非法区间（越界）
        r = await call(base, 'POST', `/documents/${dBE}/lines/batch-edit/preview`, {
            edits: [{ lineId: beA2, startCp: 0, endCp: 99, replacement: '' }],
        });
        await expectFail(r, 400, '越界');
        assert.ok(r.json.details.some((d) => d.code === 'BAD_RANGE'));
        // 非法请求体
        await expectFail(await call(base, 'POST', `/documents/${dBE}/lines/batch-edit/preview`, {}), 400, 'edits');
        await expectFail(await call(base, 'POST', `/documents/${dBE}/lines/batch-edit/preview`, { edits: [] }), 400, '非空数组');
        r = await call(base, 'POST', `/documents/${dBE}/lines/batch-edit/preview`, {
            edits: [{ lineId: beA2, startCp: 3, endCp: 2, replacement: '' }],
        });
        await expectFail(r, 400, '区间非法');
        assert.ok(r.json.details.some((d) => d.code === 'BAD_SHAPE'));
        r = await call(base, 'POST', `/documents/${dBE}/lines/batch-edit/preview`, {
            edits: [{ lineId: beA2, startCp: 0, endCp: 1, replacement: 123 }],
        });
        await expectFail(r, 400, 'replacement');
        // 行不存在 → 404
        await expectFail(await call(base, 'POST', `/documents/${dBE}/lines/batch-edit/preview`, {
            edits: [{ lineId: 999999, startCp: 0, endCp: 1, replacement: 'x' }],
        }), 404, '不存在');
        // 跨文献行 → 400 定位（用恢复测试文献的行 ca1）
        r = await call(base, 'POST', `/documents/${dBE}/lines/batch-edit/preview`, {
            edits: [
                { lineId: beA2, startCp: 0, endCp: 1, replacement: '本' },
                { lineId: ca1, startCp: 0, endCp: 1, replacement: '他' },
            ],
        });
        await expectFail(r, 400, '不属于文献');
        assert.ok(r.json.details.some((d) => d.code === 'LINE_NOT_IN_DOC' && d.lineId === ca1));
        // 文献不存在 → 404
        await expectFail(await call(base, 'POST', `/documents/999999/lines/batch-edit/preview`, {
            edits: [{ lineId: beA2, startCp: 0, endCp: 1, replacement: 'x' }],
        }), 404, '不存在');
        // 任何预览 / 失败提交均不推进版本
        beView = (await call(base, 'GET', `/documents/${dBE}`)).json;
        // （前面唯一一次成功提交推进了 1；修复组1又推进 1）
        // ---- 提交：缺 basis 400、版本过期 409、basis 不符 409 BATCH_EDIT_STALE，皆不写入不推进 ----
        const beCur = beView.document.version;
        const curA2 = beView.rawByMs.find((x) => x.msId === beA.id).lines[1].content;
        await expectFail(await call(base, 'POST', `/documents/${dBE}/lines/batch-edit`, {
            expectedVersion: beCur,
            edits: [{ lineId: beA2, startCp: 0, endCp: 1, replacement: '改' }],
        }), 400, 'basis');
        // 版本过期
        bep = (await call(base, 'POST', `/documents/${dBE}/lines/batch-edit/preview`, {
            edits: [{ lineId: beA2, startCp: 0, endCp: 1, replacement: '改' }],
        })).json;
        await expectFail(await call(base, 'POST', `/documents/${dBE}/lines/batch-edit`, {
            expectedVersion: beCur - 1,
            edits: [{ lineId: beA2, startCp: 0, endCp: 1, replacement: '改' }],
            basis: bep.basis,
        }), 409, '版本已过期');
        // basis 张冠李戴（内容不符）→ 409 BATCH_EDIT_STALE
        const tamperedBasis = bep.basis.map((b) => b.lineId === beA2 ? { ...b, content: b.content + '被改动' } : b);
        await expectFail(await call(base, 'POST', `/documents/${dBE}/lines/batch-edit`, {
            expectedVersion: beCur,
            edits: [{ lineId: beA2, startCp: 0, endCp: 1, replacement: '改' }],
            basis: tamperedBasis,
        }), 409, '预览所依据的行已变化');
        // basis 行集合不一致（缺一条）→ 409
        await expectFail(await call(base, 'POST', `/documents/${dBE}/lines/batch-edit`, {
            expectedVersion: beCur,
            edits: [
                { lineId: beA2, startCp: 0, endCp: 1, replacement: '改' },
                { lineId: beC2, startCp: 0, endCp: 1, replacement: '动' },
            ],
            basis: bep.basis,
        }), 409, '预览所依据的行已变化');
        // 拒绝后数据不变、版本不推进
        beView = (await call(base, 'GET', `/documents/${dBE}`)).json;
        assert.strictEqual(beView.document.version, beCur, '拒绝不得推进版本');
        assert.strictEqual(beView.rawByMs.find((x) => x.msId === beA.id).lines[1].content, curA2, '拒绝不得写入');
        // ---- 成功提交后旧发布快照保持原样 ----
        // 先把所有组修复到完好并发布第 1 版
        beView = (await call(base, 'GET', `/documents/${dBE}`)).json;
        if (beView.stats.brokenCount > 0) {
            // 丙行2 已在预览中计划过越界但未提交；这里确保工作版无待修复（预览不写库，brokenCount 应仍为修复后的 0）
            assert.strictEqual(beView.stats.brokenCount, 0);
        }
        r = await call(base, 'POST', `/documents/${dBE}/publish`, { expectedVersion: beView.document.version });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        const beEditionNo = r.json.editionNo;
        const snapBefore = (await call(base, 'GET', `/documents/${dBE}/editions/${beEditionNo}`)).json;
        const snapA1 = snapBefore.view.rawByMs.find((x) => x.msId === beA.id).lines[0].content;
        beView = (await call(base, 'GET', `/documents/${dBE}`)).json;
        const vBeforeFinalEdit = beView.document.version;
        r = await call(base, 'POST', `/documents/${dBE}/lines/batch-edit`, {
            expectedVersion: vBeforeFinalEdit,
            edits: [{ lineId: beA2, startCp: 0, endCp: 1, replacement: '@' }],
            basis: [
                {
                    lineId: beA2,
                    lineNo: 2,
                    msId: beA.id,
                    msName: '甲',
                    content: beView.rawByMs.find((x) => x.msId === beA.id).lines[1].content,
                    lengthCp: 5,
                },
            ],
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        const snapAfter = (await call(base, 'GET', `/documents/${dBE}/editions/${beEditionNo}`)).json;
        assert.strictEqual(snapAfter.view.rawByMs.find((x) => x.msId === beA.id).lines[0].content, snapA1, '已发布快照保持原样');
        // ---- 扩展 B 区生僻字按 Unicode 码点计 ----
        beView = (await call(base, 'GET', `/documents/${dBE}`)).json;
        const vForAstral = beView.document.version;
        r = await call(base, 'POST', `/manuscripts/${beC.id}/lines`, { expectedVersion: vForAstral, content: '𫬺𰻞AB' });
        assert.strictEqual(r.status, 201);
        beView = (await call(base, 'GET', `/documents/${dBE}`)).json;
        const beC3 = beView.rawByMs.find((x) => x.msId === beC.id).lines[2].lineId;
        bep = (await call(base, 'POST', `/documents/${dBE}/lines/batch-edit/preview`, {
            edits: [{ lineId: beC3, startCp: 2, endCp: 3, replacement: '𠀀' }],
        })).json;
        assert.strictEqual(bep.lines.find((l) => l.lineId === beC3).newContent, '𫬺𰻞𠀀B', '按码点替换第 3 个字（代理对安全）');
        assert.strictEqual(bep.lines.find((l) => l.lineId === beC3).oldLengthCp, 4);
        // ---------- 文献归档：导出 / 导入 ----------
        // 独立文献：三抄本、三组（含缺文），发布第 1 版后改短底本行制造两个待修复组（其一越界）
        r = await call(base, 'POST', '/documents', { title: `归档测试 ${++seq}`, manuscripts: ['甲本', '乙本', '丙本'] });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        const dArc = r.json.id;
        let arcView = (await call(base, 'GET', `/documents/${dArc}`)).json;
        const [arcA, arcB, arcC] = arcView.manuscripts;
        await call(base, 'POST', `/manuscripts/${arcA.id}/lines`, { expectedVersion: arcView.document.version, content: '天命之謂性率性之謂道' });
        arcView = (await call(base, 'GET', `/documents/${dArc}`)).json;
        await call(base, 'POST', `/manuscripts/${arcA.id}/lines`, { expectedVersion: arcView.document.version, content: '修道之謂教' });
        arcView = (await call(base, 'GET', `/documents/${dArc}`)).json;
        await call(base, 'POST', `/manuscripts/${arcB.id}/lines`, { expectedVersion: arcView.document.version, content: '天命之謂姓率性之謂道' });
        arcView = (await call(base, 'GET', `/documents/${dArc}`)).json;
        await call(base, 'POST', `/manuscripts/${arcB.id}/lines`, { expectedVersion: arcView.document.version, content: '修道之謂教' });
        arcView = (await call(base, 'GET', `/documents/${dArc}`)).json;
        await call(base, 'POST', `/manuscripts/${arcC.id}/lines`, { expectedVersion: arcView.document.version, content: '天命之謂性' });
        arcView = (await call(base, 'GET', `/documents/${dArc}`)).json;
        await call(base, 'POST', `/manuscripts/${arcC.id}/lines`, { expectedVersion: arcView.document.version, content: '修道之謂教' });
        arcView = (await call(base, 'GET', `/documents/${dArc}`)).json;
        const arcLines = (msId, v) => v.rawByMs.find((x) => x.msId === msId).lines;
        const arcA1 = arcLines(arcA.id, arcView)[0].lineId;
        const arcA2 = arcLines(arcA.id, arcView)[1].lineId;
        const arcB1 = arcLines(arcB.id, arcView)[0].lineId;
        const arcB2 = arcLines(arcB.id, arcView)[1].lineId;
        const arcC1 = arcLines(arcC.id, arcView)[0].lineId;
        const arcC2 = arcLines(arcC.id, arcView)[1].lineId;
        r = await call(base, 'PUT', `/documents/${dArc}/groups`, {
            expectedVersion: arcView.document.version,
            groups: [
                { ord: 1, fragments: [
                        { msId: arcA.id, lineId: arcA1, startCp: 0, endCp: 5 },
                        { msId: arcB.id, lineId: arcB1, startCp: 0, endCp: 5 },
                        { msId: arcC.id, lineId: arcC1, startCp: 0, endCp: 5 },
                    ] },
                { ord: 2, fragments: [
                        { msId: arcA.id, lineId: arcA1, startCp: 5, endCp: 10 },
                        { msId: arcB.id, lineId: arcB1, startCp: 5, endCp: 10 },
                        { msId: arcC.id, missing: true },
                    ] },
                { ord: 3, fragments: [
                        { msId: arcA.id, lineId: arcA2, startCp: 0, endCp: 5 },
                        { msId: arcB.id, lineId: arcB2, startCp: 0, endCp: 5 },
                        { msId: arcC.id, lineId: arcC2, startCp: 0, endCp: 5 },
                    ] },
            ],
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        arcView = (await call(base, 'GET', `/documents/${dArc}`)).json;
        r = await call(base, 'POST', `/documents/${dArc}/publish`, { expectedVersion: arcView.document.version });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        assert.strictEqual(r.json.editionNo, 1);
        // 改短底本行1（10 字 → 5 字）：组1 相交待修复（坐标仍在行内），组2 越界待修复（坐标保留）
        arcView = (await call(base, 'GET', `/documents/${dArc}`)).json;
        r = await call(base, 'PUT', `/lines/${arcA1}`, {
            expectedVersion: arcView.document.version,
            startCp: 0, endCp: 10, replacement: '天命之謂性',
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        arcView = (await call(base, 'GET', `/documents/${dArc}`)).json;
        assert.strictEqual(arcView.stats.brokenCount, 2, '组1、组2 待修复');
        const arcVersion = arcView.document.version;
        // ---- 导出：格式 / 内容 / 同一已提交版本 ----
        r = await call(base, 'GET', `/documents/${dArc}/archive`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        const arc = r.json;
        assert.strictEqual(arc.format, 'collation-archive', '归档带格式标识');
        assert.strictEqual(arc.formatVersion, 1, '归档带格式版本');
        assert.ok(typeof arc.exportedAt === 'string' && arc.exportedAt.length > 0);
        assert.strictEqual(arc.document.title, `归档测试 ${seq}`);
        assert.strictEqual(arc.document.version, arcVersion, '归档含导出时工作版版本号');
        assert.strictEqual(arc.document.publishedVer, 1);
        assert.strictEqual(arc.document.baseMsRef, arcA.id, '底本引用');
        assert.strictEqual(arc.manuscripts.length, 3);
        assert.deepStrictEqual(arc.manuscripts.map((m) => m.position), [1, 2, 3], '抄本及顺序');
        assert.strictEqual(arc.lines.length, 6);
        assert.strictEqual(arc.groups.length, 3);
        assert.strictEqual(arc.groups[0].broken, true, '待修复状态入档');
        assert.strictEqual(arc.groups[1].broken, true);
        assert.strictEqual(arc.groups[2].broken, false);
        const arcG2Base = arc.groups[1].fragments.find((f) => f.msRef === arcA.id);
        assert.deepStrictEqual([arcG2Base.startCp, arcG2Base.endCp], [5, 10], '待修复组越界坐标原样入档');
        assert.strictEqual(arc.groups[1].fragments.find((f) => f.msRef === arcC.id).missing, true, '缺文标记入档');
        assert.strictEqual(arc.editions.length, 1, '全部已发布版快照入档');
        assert.strictEqual(arc.editions[0].editionNo, 1);
        assert.strictEqual(arc.editions[0].snapshot.groups.length, 3);
        // 导出只读：不推进版本
        arcView = (await call(base, 'GET', `/documents/${dArc}`)).json;
        assert.strictEqual(arcView.document.version, arcVersion, '导出不得推进版本');
        // 再导出一次：除导出时刻外逐字节一致（同一已提交版本的确定性内容）
        const arcAgain = (await call(base, 'GET', `/documents/${dArc}/archive`)).json;
        assert.deepStrictEqual({ ...arcAgain, exportedAt: null }, { ...arc, exportedAt: null }, '未改动时重复导出内容一致');
        // ---- 导入：创建独立新文献，内部标识全部重建 ----
        r = await call(base, 'POST', '/documents/import', arc);
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        const dImp = r.json.documentId;
        assert.notStrictEqual(dImp, dArc);
        assert.strictEqual(r.json.title, `归档测试 ${seq}`);
        assert.strictEqual(r.json.version, arcVersion, '工作版版本号随归档重建');
        assert.strictEqual(r.json.publishedVer, 1);
        assert.deepStrictEqual(r.json.imported, {
            manuscriptCount: 3, lineCount: 6, groupCount: 3,
            brokenGroupCount: 2, fragmentCount: 9, missingCount: 1, editionCount: 1,
        });
        let impView = (await call(base, 'GET', `/documents/${dImp}`)).json;
        assert.strictEqual(impView.document.version, arcVersion);
        assert.strictEqual(impView.document.publishedVer, 1);
        const [impA, impB, impC] = impView.manuscripts;
        assert.strictEqual(impA.name, '甲本');
        assert.ok(impA.isBase, '底本随归档重建');
        assert.ok(impA.id !== arcA.id && impB.id !== arcB.id && impC.id !== arcC.id, '抄本取得新标识');
        const impLines = (msId) => impView.rawByMs.find((x) => x.msId === msId).lines;
        assert.strictEqual(impLines(impA.id)[0].content, '天命之謂性', '行序与文字不变');
        assert.strictEqual(impLines(impA.id)[1].content, '修道之謂教');
        assert.strictEqual(impLines(impB.id)[0].content, '天命之謂姓率性之謂道');
        assert.strictEqual(impView.stats.groupCount, 3);
        assert.strictEqual(impView.stats.brokenCount, 2, '待修复状态保留');
        const impG2 = impView.groups.find((g) => g.ord === 2);
        const impG2Base = impG2.cells.find((c) => c.msId === impA.id);
        assert.deepStrictEqual([impG2Base.startCp, impG2Base.endCp], [5, 10], '待修复组越界坐标保留');
        assert.strictEqual(impG2Base.oobEnd, 5, '越界前可见部分标识一致');
        assert.strictEqual(impG2.cells.find((c) => c.msId === impC.id).missing, true, '缺文状态保留');
        const impG3 = impView.groups.find((g) => g.ord === 3);
        assert.strictEqual(impG3.broken, false);
        assert.strictEqual(impG3.baseText, '修道之謂教');
        // 旧版仍可阅读：快照内标识已重建为新文献的 id
        const impEditions = (await call(base, 'GET', `/documents/${dImp}/editions`)).json;
        assert.strictEqual(impEditions.editions.length, 1);
        const impEd1 = (await call(base, 'GET', `/documents/${dImp}/editions/1`)).json;
        assert.strictEqual(impEd1.view.document.id, dImp, '快照文献 id 已重建');
        assert.strictEqual(impEd1.view.document.baseMsId, impA.id, '快照底本引用已重建');
        assert.deepStrictEqual(impEd1.view.manuscripts.map((m) => m.id).sort((x, y) => x - y), [impA.id, impB.id, impC.id].sort((x, y) => x - y), '快照抄本引用已重建为新标识');
        assert.strictEqual(impEd1.view.groups[0].baseText, '天命之謂性');
        // 旧版仍可对照：快照与工作版按新标识配对
        const impDiff = (await call(base, 'GET', `/documents/${dImp}/editions/1/diff`)).json;
        assert.strictEqual(impDiff.baseSame, true);
        assert.ok(impDiff.manuscripts.every((m) => m.inOld && m.inNew), '对照按新标识匹配抄本');
        assert.strictEqual(impDiff.groupDiff.counts.paired, 3, '底本位置一一对应仍可配对');
        assert.ok(impDiff.textChanges.some((t) => t.msName === '甲本' && t.lineNo === 1 && t.status === 'changed'), '行文差异照常呈现');
        // 旧版仍可恢复：待修复组被快照状态整体重建
        impView = (await call(base, 'GET', `/documents/${dImp}`)).json;
        r = await call(base, 'POST', `/documents/${dImp}/editions/1/restore`, { expectedVersion: impView.document.version });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert.strictEqual(r.json.version, impView.document.version + 1, '恢复只推进一次版本');
        impView = (await call(base, 'GET', `/documents/${dImp}`)).json;
        assert.strictEqual(impView.stats.brokenCount, 0, '恢复后无待修复');
        assert.strictEqual(impLines(impA.id)[0].content, '天命之謂性率性之謂道');
        const impDiff2 = (await call(base, 'GET', `/documents/${dImp}/editions/1/diff`)).json;
        assert.strictEqual(impDiff2.textChanges.length, 0, '恢复后与第 1 版完全一致');
        assert.strictEqual(impDiff2.groupDiff.counts.pairedChanged, 0);
        // 导入不改动源文献
        arcView = (await call(base, 'GET', `/documents/${dArc}`)).json;
        assert.strictEqual(arcView.document.version, arcVersion, '源文献版本不变');
        assert.strictEqual(arcView.stats.brokenCount, 2, '源文献待修复状态不变');
        assert.strictEqual((await call(base, 'GET', `/documents/${dArc}/editions`)).json.editions.length, 1);
        // 新文献仍可编辑并按现有门禁发布
        impView = (await call(base, 'GET', `/documents/${dImp}`)).json;
        r = await call(base, 'POST', `/manuscripts/${impB.id}/lines`, { expectedVersion: impView.document.version, content: '附加一行' });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        impView = (await call(base, 'GET', `/documents/${dImp}`)).json;
        r = await call(base, 'POST', `/documents/${dImp}/publish`, { expectedVersion: impView.document.version });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        assert.strictEqual(r.json.editionNo, 2, '在导入文献上继续编号发布');
        // ---- 同一文件重复导入：各自创建独立文献 ----
        r = await call(base, 'POST', '/documents/import', arc);
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        const dImp2 = r.json.documentId;
        assert.ok(dImp2 !== dArc && dImp2 !== dImp, '重复导入各自独立');
        let imp2View = (await call(base, 'GET', `/documents/${dImp2}`)).json;
        // 导入文献上的现有门禁：待修复组未修复前不得发布
        r = await call(base, 'POST', `/documents/${dImp2}/publish`, { expectedVersion: imp2View.document.version });
        await expectFail(r, 409, '待修复');
        r = await call(base, 'POST', `/documents/${dImp2}/manuscripts`, { expectedVersion: imp2View.document.version, name: '丁本' });
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        impView = (await call(base, 'GET', `/documents/${dImp}`)).json;
        assert.strictEqual(impView.manuscripts.length, 3, '另一导入副本不受影响');
        // ---- 多发布版归档：导出含 2 版的文献再导入，两个快照都可阅读、对照、恢复 ----
        const arcTwoEd = (await call(base, 'GET', `/documents/${dImp}/archive`)).json;
        assert.strictEqual(arcTwoEd.editions.length, 2);
        assert.strictEqual(arcTwoEd.document.publishedVer, 2);
        r = await call(base, 'POST', '/documents/import', arcTwoEd);
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        const dImp3 = r.json.documentId;
        let imp3View = (await call(base, 'GET', `/documents/${dImp3}`)).json;
        assert.strictEqual(imp3View.document.publishedVer, 2);
        assert.strictEqual((await call(base, 'GET', `/documents/${dImp3}/editions`)).json.editions.length, 2);
        r = await call(base, 'POST', `/documents/${dImp3}/editions/2/restore`, { expectedVersion: imp3View.document.version });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        imp3View = (await call(base, 'GET', `/documents/${dImp3}`)).json;
        r = await call(base, 'POST', `/documents/${dImp3}/editions/1/restore`, { expectedVersion: imp3View.document.version });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        imp3View = (await call(base, 'GET', `/documents/${dImp3}`)).json;
        assert.strictEqual(imp3View.stats.brokenCount, 0);
        assert.strictEqual(imp3View.rawByMs.find((x) => x.msId === imp3View.manuscripts[1].id).lines.length, 2, '第 1 版尚无后增行');
        // ---- 历史快照含工作版已删除的抄本：导入保留全新标识，恢复时可物化 ----
        const ghostArc = JSON.parse(JSON.stringify(arc));
        ghostArc.editions[0].snapshot.manuscripts.push({ id: 987654, name: '丁本', position: 4, isBase: false });
        ghostArc.editions[0].snapshot.rawByMs.push({ msId: 987654, lines: [] });
        r = await call(base, 'POST', '/documents/import', ghostArc);
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        const dGhost = r.json.documentId;
        let ghostView = (await call(base, 'GET', `/documents/${dGhost}`)).json;
        assert.strictEqual(ghostView.manuscripts.length, 3, '工作版不含快照独有抄本');
        r = await call(base, 'POST', `/documents/${dGhost}/editions/1/restore`, { expectedVersion: ghostView.document.version });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        ghostView = (await call(base, 'GET', `/documents/${dGhost}`)).json;
        assert.strictEqual(ghostView.manuscripts.length, 4, '恢复快照后该抄本物化');
        const ghostMs = ghostView.manuscripts.find((m) => m.name === '丁本');
        assert.ok(ghostMs, '快照独有抄本已物化');
        assert.notStrictEqual(ghostMs.id, 987654, '物化抄本使用重建后的新标识');
        // ---- 正向变体：空组列表、待修复组缺底本片段均可导入 ----
        const noGroupsArc = JSON.parse(JSON.stringify(arc));
        noGroupsArc.groups = [];
        r = await call(base, 'POST', '/documents/import', noGroupsArc);
        assert.strictEqual(r.status, 201, JSON.stringify(r.json));
        assert.strictEqual(r.json.imported.groupCount, 0);
        const noBaseBrokenArc = JSON.parse(JSON.stringify(arc));
        noBaseBrokenArc.groups[0].fragments = noBaseBrokenArc.groups[0].fragments.filter((f) => f.msRef !== arcA.id);
        r = await call(base, 'POST', '/documents/import', noBaseBrokenArc);
        assert.strictEqual(r.status, 201, `待修复组可缺底本片段：${JSON.stringify(r.json)}`);
        assert.strictEqual(r.json.imported.brokenGroupCount, 2);
        // ---- 导入校验：未知格式 / 缺失引用 / 损坏快照 / 完好组非法区间等逐条定位、整次拒绝 ----
        const docsCount = async () => (await call(base, 'GET', '/documents')).json.documents.length;
        const arcClone = () => JSON.parse(JSON.stringify(arc));
        const expectImportFail = async (mutated, phrase, code) => {
            const before = await docsCount();
            const rr = await call(base, 'POST', '/documents/import', mutated);
            await expectFail(rr, 400, phrase);
            assert.strictEqual(rr.json.details.code, 'ARCHIVE_INVALID', '统一错误代码');
            if (code) {
                assert.ok(rr.json.details.issues.some((it) => it.code === code), `issues 应含 ${code}：${JSON.stringify(rr.json.details)}`);
            }
            assert.strictEqual(await docsCount(), before, '整次拒绝：不得创建任何文献');
            return rr;
        };
        // 未知格式 / 格式版本 / 非对象
        await expectImportFail([], 'JSON 对象', 'UNKNOWN_FORMAT');
        await expectImportFail({ ...arcClone(), format: 'other-format' }, '未知归档格式', 'UNKNOWN_FORMAT');
        await expectImportFail({ ...arcClone(), formatVersion: 99 }, '格式版本', 'UNKNOWN_FORMAT_VERSION');
        // 元信息缺失
        await expectImportFail((() => { const x = arcClone(); delete x.document; return x; })(), 'document.title', 'BAD_SHAPE');
        // 底本引用缺失
        await expectImportFail((() => { const x = arcClone(); x.document.baseMsRef = 999999; return x; })(), '底本', 'NO_BASE');
        // 抄本：重名 / 顺序不连续
        await expectImportFail((() => { const x = arcClone(); x.manuscripts[1].name = '甲本'; return x; })(), '重复', 'DUP_MS');
        await expectImportFail((() => { const x = arcClone(); x.manuscripts[2].position = 9; return x; })(), 'position', 'BAD_POSITION');
        // 行：引用不存在的抄本 / 行号不连续
        await expectImportFail((() => { const x = arcClone(); x.lines[0].msRef = 999999; return x; })(), '缺失引用', 'BAD_MS_REF');
        await expectImportFail((() => { const x = arcClone(); x.lines.find((l) => l.msRef === arcA.id && l.lineNo === 2).lineNo = 3; return x; })(), '行号不连续', 'LINE_NO_GAP');
        // 片段悬空引用：抄本 / 行 / 他抄本的行
        await expectImportFail((() => { const x = arcClone(); x.groups[0].fragments[0].msRef = 999999; return x; })(), '悬空引用', 'BAD_MS_REF');
        await expectImportFail((() => { const x = arcClone(); x.groups[2].fragments[0].lineRef = 999999; return x; })(), '悬空引用', 'BAD_LINE_REF');
        await expectImportFail((() => {
            const x = arcClone();
            x.groups[2].fragments[0].lineRef = x.lines.find((l) => l.msRef === arcB.id && l.lineNo === 1).ref;
            return x;
        })(), '他抄本的行', 'LINE_MS_MISMATCH');
        // 待修复组真实片段：负值 / 逆序 / 零长度 一律拒绝
        await expectImportFail((() => { const x = arcClone(); x.groups[0].fragments[0].startCp = -1; return x; })(), '负值', 'BAD_RANGE');
        await expectImportFail((() => { const x = arcClone(); x.groups[0].fragments[0].startCp = 3; x.groups[0].fragments[0].endCp = 2; return x; })(), '逆序', 'BAD_RANGE');
        await expectImportFail((() => { const x = arcClone(); x.groups[0].fragments[0].startCp = 2; x.groups[0].fragments[0].endCp = 2; return x; })(), '零长度', 'BAD_RANGE');
        // 完好组非法区间：越界 / 重叠 / 缺底本（按现行归组规则拒绝）
        await expectImportFail((() => { const x = arcClone(); x.groups[2].fragments[0].endCp = 99; return x; })(), '越界', 'OUT_OF_RANGE');
        await expectImportFail((() => {
            const x = arcClone();
            x.groups[0].broken = false;
            x.groups[1].broken = false;
            const g2b = x.groups[1].fragments.find((f) => f.msRef === arcA.id);
            g2b.startCp = 0;
            g2b.endCp = 5; // 与组1 底本 [0,5) 重叠
            return x;
        })(), '重叠归组', 'OVERLAP');
        await expectImportFail((() => { const x = arcClone(); x.groups[2].fragments = x.groups[2].fragments.filter((f) => f.msRef !== arcA.id); return x; })(), '缺少底本片段', 'NO_BASE');
        // 组：空组 / 组序重复 / 组序缺号
        await expectImportFail((() => { const x = arcClone(); x.groups[2].fragments = []; return x; })(), '没有任何片段', 'EMPTY_GROUP');
        await expectImportFail((() => { const x = arcClone(); x.groups[1].ord = 1; return x; })(), '重复', 'DUP_ORD');
        await expectImportFail((() => { const x = arcClone(); x.groups[2].ord = 5; return x; })(), '连续', 'ORD_GAP');
        // 发布版：编号缺号 / 与 publishedVer 不一致 / 快照损坏（逐条定位到版号）
        await expectImportFail((() => { const x = arcClone(); x.editions[0].editionNo = 2; return x; })(), '自 1 起连续', 'EDITION_NO_GAP');
        await expectImportFail((() => { const x = arcClone(); x.document.publishedVer = 0; return x; })(), '不一致', 'PUBLISHED_VER_MISMATCH');
        {
            const x = arcClone();
            x.editions[0].snapshot.groups[0].cells.find((c) => c.msId === arcA.id).endCp = 99;
            const rr = await expectImportFail(x, '快照', 'SNAPSHOT_OUT_OF_RANGE');
            assert.ok(rr.json.details.issues.some((it) => it.editionNo === 1), '快照问题须定位到发布版编号');
        }
        // 全部拒绝后源文献依旧不变
        arcView = (await call(base, 'GET', `/documents/${dArc}`)).json;
        assert.strictEqual(arcView.document.version, arcVersion, '失败导入不触及源文献');
        console.log('✅ 全部集成测试通过');
    }
    finally {
        await close();
    }
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
