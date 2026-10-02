"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildView = buildView;
exports.sameLineOverlap = sameLineOverlap;
const util_1 = require("./util");
/**
 * 构建校勘对照读模型：
 *  - groups 依底本顺序（ord）排列，逐组给出各抄本文字、异文、缺文、倒置、待修复标记；
 *  - rawByMs 按各抄本原始行序给出全部行（未归组文字自然可见）。
 */
async function buildView(client, doc) {
    const { rows: mss } = await client.query('SELECT id, doc_id, name, position FROM manuscripts WHERE doc_id=$1 ORDER BY position, id', [doc.id]);
    const { rows: lines } = await client.query(`SELECT id, ms_id, line_no, content FROM lines
     WHERE ms_id = ANY($1::bigint[]) ORDER BY ms_id, line_no`, [mss.map((m) => m.id)]);
    const { rows: groups } = await client.query('SELECT id, doc_id, ord, broken FROM grp WHERE doc_id=$1 ORDER BY ord', [doc.id]);
    const { rows: frags } = await client.query(`SELECT id, group_id, doc_id, ms_id, line_id, start_cp, end_cp, missing
     FROM fragments WHERE doc_id=$1 ORDER BY id`, [doc.id]);
    const msById = new Map(mss.map((m) => [m.id, m]));
    const lineById = new Map(lines.map((l) => [l.id, l]));
    const fragsByGroup = new Map();
    for (const f of frags) {
        const arr = fragsByGroup.get(f.group_id) ?? [];
        arr.push(f);
        fragsByGroup.set(f.group_id, arr);
    }
    const baseId = doc.base_ms_id;
    // 倒置检测：以“底本片段”为基准。
    // 若某抄本在连续两组 g1(ord<g2) 中的有效片段位置顺序与底本相反，则这些组标倒置。
    const orderPos = (f) => {
        if (!f || f.missing || !f.line_id)
            return Number.MAX_SAFE_INTEGER;
        const ln = lineById.get(f.line_id);
        const lineNo = ln ? ln.line_no : 0;
        // 行序为主、码点偏移为辅的标量位置
        return lineNo * 1e9 + (f.start_cp ?? 0);
    };
    // 计算每个非底本抄本相对底本的逆序对所涉组
    const invertedGroupIds = new Set();
    const baseFragOf = new Map();
    groups.forEach((g) => baseFragOf.set(g.id, (fragsByGroup.get(g.id) ?? []).find((f) => f.ms_id === baseId && !f.missing)));
    for (const ms of mss) {
        if (ms.id === baseId)
            continue;
        const seq = [];
        for (const g of groups) {
            const ff = (fragsByGroup.get(g.id) ?? []).find((f) => f.ms_id === ms.id && !f.missing);
            if (!ff)
                continue;
            seq.push({ gid: g.id, p: orderPos(ff), bp: orderPos(baseFragOf.get(g.id)) });
        }
        // 以底本顺序（bp 升序，等同 groups 顺序）遍历，若该抄本位置 p 出现下降 → 倒置
        for (let i = 1; i < seq.length; i++) {
            if (seq[i].p < seq[i - 1].p) {
                invertedGroupIds.add(seq[i - 1].gid);
                invertedGroupIds.add(seq[i].gid);
            }
        }
    }
    const groupViews = groups.map((g) => {
        const cells = [];
        const fs = fragsByGroup.get(g.id) ?? [];
        let hasMissing = false;
        let variant = false;
        let baseText = '';
        for (const ms of mss) {
            const f = fs.find((x) => x.ms_id === ms.id);
            if (!f) {
                cells.push({ msId: ms.id, missing: false, broken: false });
                continue;
            }
            if (f.missing) {
                hasMissing = true;
                cells.push({ msId: ms.id, missing: true, broken: g.broken });
                continue;
            }
            const ln = f.line_id ? lineById.get(f.line_id) : undefined;
            let broken = g.broken;
            let text;
            let oobEnd;
            let lineNo;
            let startCp = f.start_cp ?? undefined;
            let endCp = f.end_cp ?? undefined;
            if (!ln || ln.ms_id !== ms.id || f.start_cp == null || f.end_cp == null) {
                broken = true;
            }
            else {
                lineNo = ln.line_no;
                const len = (0, util_1.charLen)(ln.content);
                const s = f.start_cp;
                const e = f.end_cp;
                if (s < 0 || e <= s || s > len) {
                    broken = true; // 完全越界
                }
                else if (e > len) {
                    broken = true; // 原文缩短导致越界 → 待修复
                    oobEnd = len;
                    text = (0, util_1.sliceCp)(ln.content, s, len);
                }
                else {
                    text = (0, util_1.sliceCp)(ln.content, s, e);
                }
            }
            const cell = {
                msId: ms.id,
                missing: false,
                broken,
                lineNo,
                startCp,
                endCp,
                text,
                oobEnd,
            };
            if (ms.id === baseId)
                baseText = text ?? '';
            cells.push(cell);
        }
        // 异文：非底本的真实片段文字与底本不一致
        if (baseId != null) {
            for (const c of cells) {
                if (c.msId === baseId || c.missing)
                    continue;
                if (c.text !== undefined && c.text !== baseText) {
                    variant = true;
                    break;
                }
            }
        }
        return {
            id: g.id,
            ord: g.ord,
            broken: g.broken,
            baseText,
            inverted: invertedGroupIds.has(g.id),
            cells,
            variant,
            hasMissing,
        };
    });
    // 各抄本原始行序 + 覆盖区间
    const fragsByMs = new Map();
    for (const f of frags) {
        if (f.missing || !f.line_id)
            continue;
        const arr = fragsByMs.get(f.ms_id) ?? [];
        arr.push(f);
        fragsByMs.set(f.ms_id, arr);
    }
    const groupById = new Map(groups.map((g) => [g.id, g]));
    const rawByMs = mss.map((ms) => {
        const msLines = lines
            .filter((l) => l.ms_id === ms.id)
            .map((l) => {
            const covered = (fragsByMs.get(ms.id) ?? [])
                .filter((f) => f.line_id === l.id && f.start_cp != null && f.end_cp != null)
                .map((f) => ({
                startCp: Math.max(0, f.start_cp),
                endCp: Math.min((0, util_1.charLen)(l.content), f.end_cp),
                groupId: f.group_id,
                broken: groupById.get(f.group_id)?.broken ?? false,
            }))
                .filter((c) => c.endCp > c.startCp)
                .sort((a, b) => a.startCp - b.startCp);
            return { lineId: l.id, lineNo: l.line_no, content: l.content, covered };
        });
        return { msId: ms.id, lines: msLines };
    });
    return {
        document: {
            id: doc.id,
            title: doc.title,
            version: doc.version,
            baseMsId: baseId,
            publishedVer: doc.published_ver,
        },
        manuscripts: mss.map((m) => ({
            id: m.id,
            name: m.name,
            position: m.position,
            isBase: m.id === baseId,
        })),
        groups: groupViews,
        rawByMs,
        stats: {
            manuscriptCount: mss.length,
            lineCount: lines.length,
            groupCount: groups.length,
            brokenCount: groups.filter((g) => g.broken).length,
        },
    };
}
/** 供测试 / 发布快照复用：直接判定两片段在同一行内是否重叠。 */
function sameLineOverlap(a, b) {
    if (a.ms_id !== b.ms_id || a.missing || b.missing)
        return false;
    if (a.line_id == null || b.line_id == null || a.line_id !== b.line_id)
        return false;
    if (a.start_cp == null || a.end_cp == null || b.start_cp == null || b.end_cp == null) {
        return false;
    }
    return (0, util_1.rangesOverlap)(a.start_cp, a.end_cp, b.start_cp, b.end_cp);
}
