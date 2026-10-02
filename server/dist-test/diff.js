"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.charDiff = charDiff;
exports.buildEditionDiff = buildEditionDiff;
function buildSide(view, side) {
    const msById = new Map();
    for (const m of view.manuscripts) {
        msById.set(m.id, { id: m.id, name: m.name, position: m.position, isBase: m.isBase });
    }
    const cellsByGroup = new Map();
    for (const g of view.groups) {
        const cellMap = new Map();
        for (const c of g.cells) {
            // 无片段、无行信息时按“无片段”处理（空 cell）
            if (c.missing) {
                cellMap.set(c.msId, {
                    msId: c.msId,
                    state: 'missing',
                    broken: c.broken || g.broken,
                    outOfBounds: false,
                    text: null,
                    visibleText: null,
                    lineNo: null,
                    startCp: null,
                    endCp: null,
                    oobEnd: null,
                });
            }
            else if (c.lineNo != null && c.startCp != null && c.endCp != null) {
                // 片段自身越界（原文缩短）→ 待修复，现存部分不作确定文字；
                // 仅组连带待修复、片段仍在行内 → 字面文字确定，但显式带待修复标识
                const selfOutOfBounds = c.broken && c.oobEnd != null;
                const broken = c.broken || g.broken;
                cellMap.set(c.msId, {
                    msId: c.msId,
                    state: 'fragment',
                    broken,
                    outOfBounds: selfOutOfBounds,
                    text: selfOutOfBounds ? null : (c.text ?? ''),
                    visibleText: selfOutOfBounds ? (c.text ?? null) : null,
                    lineNo: c.lineNo,
                    startCp: c.startCp,
                    endCp: c.endCp,
                    oobEnd: c.oobEnd ?? null,
                });
            }
            else if (c.text !== undefined || c.startCp !== undefined || c.endCp !== undefined) {
                // 引用失效的片段（lineNo 缺失）：确定不可用
                cellMap.set(c.msId, {
                    msId: c.msId,
                    state: 'fragment',
                    broken: true,
                    outOfBounds: true,
                    text: null,
                    visibleText: c.text ?? null,
                    lineNo: c.lineNo ?? null,
                    startCp: c.startCp ?? null,
                    endCp: c.endCp ?? null,
                    oobEnd: c.oobEnd ?? null,
                });
            }
            else {
                cellMap.set(c.msId, {
                    msId: c.msId,
                    state: 'absent',
                    broken: false,
                    outOfBounds: false,
                    text: null,
                    visibleText: null,
                    lineNo: null,
                    startCp: null,
                    endCp: null,
                    oobEnd: null,
                });
            }
        }
        cellsByGroup.set(g.id, cellMap);
    }
    return { view, side, msById, cellsByGroup };
}
/** 底本片段位置键：(行号, 起, 止)。缺底本 / 越界失效 → 无键（不参与配对）。 */
function baseKey(g, baseMsId, cellsByGroup) {
    if (baseMsId == null)
        return null;
    const cell = cellsByGroup.get(g.id)?.get(baseMsId);
    if (!cell || cell.state !== 'fragment' || cell.lineNo == null ||
        cell.startCp == null || cell.endCp == null) {
        return null;
    }
    return `${cell.lineNo}:${cell.startCp}:${cell.endCp}`;
}
function baseLocationOf(g, baseMsId, cellsByGroup) {
    if (baseMsId == null)
        return null;
    const cell = cellsByGroup.get(g.id)?.get(baseMsId);
    if (!cell || cell.state !== 'fragment' || cell.lineNo == null ||
        cell.startCp == null || cell.endCp == null) {
        return null;
    }
    return { lineNo: cell.lineNo, startCp: cell.startCp, endCp: cell.endCp };
}
/** 找出一侧所有底本位置重复（不唯一）的键。 */
function duplicateKeys(view, baseMsId, cellsByGroup) {
    const seen = new Map();
    for (const g of view.groups) {
        const k = baseKey(g, baseMsId, cellsByGroup);
        if (k != null)
            seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    const dup = new Set();
    for (const [k, n] of seen)
        if (n > 1)
            dup.add(k);
    return dup;
}
// ---------- 行文增删改（按原始行号，码点级 LCS） ----------
/** 码点级最长公共子序列 diff，相邻同 op 自动合并。 */
function charDiff(oldStr, newStr) {
    const a = Array.from(oldStr);
    const b = Array.from(newStr);
    const n = a.length;
    const m = b.length;
    // LCS 长度表
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const raw = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            raw.push({ op: 'equal', text: a[i] });
            i++;
            j++;
        }
        else if (dp[i + 1][j] >= dp[i][j + 1]) {
            raw.push({ op: 'removed', text: a[i] });
            i++;
        }
        else {
            raw.push({ op: 'added', text: b[j] });
            j++;
        }
    }
    while (i < n)
        raw.push({ op: 'removed', text: a[i++] });
    while (j < m)
        raw.push({ op: 'added', text: b[j++] });
    const merged = [];
    for (const t of raw) {
        const last = merged[merged.length - 1];
        if (last && last.op === t.op)
            last.text += t.text;
        else
            merged.push({ ...t });
    }
    return merged;
}
function buildTextChanges(oldSide, newSide) {
    const out = [];
    const msIds = new Set([
        ...oldSide.view.rawByMs.map((r) => r.msId),
        ...newSide.view.rawByMs.map((r) => r.msId),
    ]);
    for (const msId of msIds) {
        const meta = newSide.msById.get(msId) ?? oldSide.msById.get(msId);
        const msName = meta?.name ?? `抄本#${msId}`;
        const oldLines = oldSide.view.rawByMs.find((r) => r.msId === msId)?.lines ?? [];
        const newLines = newSide.view.rawByMs.find((r) => r.msId === msId)?.lines ?? [];
        const oldByNo = new Map(oldLines.map((l) => [l.lineNo, l]));
        const newByNo = new Map(newLines.map((l) => [l.lineNo, l]));
        const lineNos = new Set([...oldByNo.keys(), ...newByNo.keys()]);
        for (const lineNo of [...lineNos].sort((x, y) => x - y)) {
            const ol = oldByNo.get(lineNo);
            const nl = newByNo.get(lineNo);
            const oldText = ol?.content ?? '';
            const newText = nl?.content ?? '';
            if (ol && !nl) {
                out.push({
                    msId, msName, lineNo, status: 'removed',
                    oldLineId: ol.lineId, newLineId: null, oldText, newText: '',
                    segments: [{ op: 'removed', text: oldText }],
                });
            }
            else if (!ol && nl) {
                out.push({
                    msId, msName, lineNo, status: 'added',
                    oldLineId: null, newLineId: nl.lineId, oldText: '', newText,
                    segments: [{ op: 'added', text: newText }],
                });
            }
            else if (ol && nl && oldText !== newText) {
                out.push({
                    msId, msName, lineNo, status: 'changed',
                    oldLineId: ol.lineId, newLineId: nl.lineId, oldText, newText,
                    segments: charDiff(oldText, newText),
                });
            }
        }
    }
    return out;
}
// ---------- 组对照 ----------
function compareCells(oldG, newG, oldSide, newSide, baseMsId) {
    const out = [];
    const msIds = new Set([
        ...oldSide.msById.keys(),
        ...newSide.msById.keys(),
    ]);
    for (const msId of msIds) {
        const o = oldSide.cellsByGroup.get(oldG.id)?.get(msId);
        const n = newSide.cellsByGroup.get(newG.id)?.get(msId);
        const oState = o?.state ?? 'absent';
        const nState = n?.state ?? 'absent';
        const changes = [];
        if (oState !== nState)
            changes.push('state');
        const oLoc = o && o.state === 'fragment'
            ? { lineNo: o.lineNo, startCp: o.startCp, endCp: o.endCp }
            : null;
        const nLoc = n && n.state === 'fragment'
            ? { lineNo: n.lineNo, startCp: n.startCp, endCp: n.endCp }
            : null;
        if ((oLoc || nLoc) &&
            (JSON.stringify(oLoc) !== JSON.stringify(nLoc))) {
            changes.push('location');
        }
        // 仅在两侧均为行内真实片段（无越界/失效）时才把文字差异作为确定结论；
        // 组是否待修复不影响字面文字的确定性
        const textChanged = !!o && !!n && o.state === 'fragment' && n.state === 'fragment' &&
            !o.outOfBounds && !n.outOfBounds
            ? (o.text ?? '') !== (n.text ?? '')
            : false;
        if (textChanged)
            changes.push('text');
        const oBroken = !!o?.broken;
        const nBroken = !!n?.broken;
        if (oBroken !== nBroken)
            changes.push('broken');
        if (changes.length === 0)
            continue;
        const meta = newSide.msById.get(msId) ?? oldSide.msById.get(msId);
        out.push({
            msId,
            msName: meta?.name ?? `抄本#${msId}`,
            isBase: msId === baseMsId,
            oldState: oState,
            newState: nState,
            changes,
            textChanged,
            oldOutOfBounds: !!o?.outOfBounds,
            newOutOfBounds: !!n?.outOfBounds,
            oldText: o?.text ?? null,
            newText: n?.text ?? null,
            newVisibleText: n?.visibleText ?? null,
            newOobEnd: n?.oobEnd ?? null,
            oldBroken: oBroken,
            newBroken: nBroken,
            oldLineNo: o?.lineNo ?? null,
            newLineNo: n?.lineNo ?? null,
            oldStartCp: o?.startCp ?? null,
            newStartCp: n?.startCp ?? null,
            oldEndCp: o?.endCp ?? null,
            newEndCp: n?.endCp ?? null,
        });
    }
    // 底本抄本置顶，其余按新侧展示顺序
    out.sort((a, b) => (a.isBase === b.isBase ? 0 : a.isBase ? -1 : 1) ||
        ((newSide.msById.get(a.msId)?.position ?? oldSide.msById.get(a.msId)?.position ?? 0) -
            (newSide.msById.get(b.msId)?.position ?? oldSide.msById.get(b.msId)?.position ?? 0)));
    return out;
}
function unpairedCells(g, sideData, baseMsId) {
    const out = [];
    for (const m of sideData.view.manuscripts) {
        const c = sideData.cellsByGroup.get(g.id)?.get(m.id);
        if (!c || c.state === 'absent')
            continue;
        out.push({
            msId: m.id,
            msName: m.name,
            isBase: baseMsId != null && m.id === baseMsId,
            state: c.state,
            broken: c.broken,
            outOfBounds: c.outOfBounds,
            text: c.text,
            visibleText: c.visibleText,
            lineNo: c.lineNo,
            startCp: c.startCp,
            endCp: c.endCp,
            oobEnd: c.oobEnd,
        });
    }
    return out;
}
function pairGroups(oldSide, newSide) {
    const oldBase = oldSide.view.document.baseMsId;
    const newBase = newSide.view.document.baseMsId;
    // 底本不同：全部分别列出，绝不配对
    if (oldBase == null || newBase == null || oldBase !== newBase) {
        const make = (sd, base, side) => sd.view.groups.map((g) => ({
            side,
            groupId: g.id,
            ord: g.ord,
            broken: g.broken,
            reason: 'base-differs',
            baseMsId: base,
            baseText: g.baseText || null,
            baseLocation: baseLocationOf(g, base, sd.cellsByGroup),
            cells: unpairedCells(g, sd, base),
        }));
        return {
            paired: [],
            unpairedOld: make(oldSide, oldBase, 'old'),
            unpairedNew: make(newSide, newBase, 'new'),
        };
    }
    const baseMsId = oldBase;
    const oldDup = duplicateKeys(oldSide.view, baseMsId, oldSide.cellsByGroup);
    const newDup = duplicateKeys(newSide.view, baseMsId, newSide.cellsByGroup);
    // 键 → 组（各自唯一时才可能配对）
    const oldByKey = new Map();
    const newByKey = new Map();
    const oldUnmatched = new Map();
    const newUnmatched = new Map();
    for (const g of oldSide.view.groups) {
        const k = baseKey(g, baseMsId, oldSide.cellsByGroup);
        const loc = baseLocationOf(g, baseMsId, oldSide.cellsByGroup);
        if (k == null) {
            oldUnmatched.set(g.id, { g, reason: 'no-base-location', loc });
        }
        else if (oldDup.has(k)) {
            oldUnmatched.set(g.id, { g, reason: 'duplicate-location', loc });
        }
        else {
            oldByKey.set(k, g);
        }
    }
    for (const g of newSide.view.groups) {
        const k = baseKey(g, baseMsId, newSide.cellsByGroup);
        const loc = baseLocationOf(g, baseMsId, newSide.cellsByGroup);
        if (k == null) {
            newUnmatched.set(g.id, { g, reason: 'no-base-location', loc });
        }
        else if (newDup.has(k)) {
            newUnmatched.set(g.id, { g, reason: 'duplicate-location', loc });
        }
        else {
            newByKey.set(k, g);
        }
    }
    const paired = [];
    for (const [k, og] of oldByKey) {
        const ng = newByKey.get(k);
        if (!ng) {
            oldUnmatched.set(og.id, { g: og, reason: 'not-matched', loc: baseLocationOf(og, baseMsId, oldSide.cellsByGroup) });
            continue;
        }
        // 一一对应（两侧各自唯一，已由 dup 集合保证）
        const cellChanges = compareCells(og, ng, oldSide, newSide, baseMsId);
        const ordChanged = og.ord !== ng.ord;
        const status = ordChanged || cellChanges.length > 0 || og.broken !== ng.broken ? 'changed' : 'same';
        const [lineNo, s, e] = k.split(':').map(Number);
        paired.push({
            status,
            oldGroupId: og.id,
            newGroupId: ng.id,
            oldOrd: og.ord,
            newOrd: ng.ord,
            ordChanged,
            oldBroken: og.broken,
            newBroken: ng.broken,
            baseMsId,
            baseLocation: { lineNo, startCp: s, endCp: e },
            cellChanges,
        });
        newByKey.delete(k);
    }
    for (const [k, ng] of newByKey) {
        newUnmatched.set(ng.id, { g: ng, reason: 'not-matched', loc: baseLocationOf(ng, baseMsId, newSide.cellsByGroup) });
    }
    const toUnpaired = (sd, map, side) => [...map.values()]
        .sort((a, b) => a.g.ord - b.g.ord)
        .map(({ g, reason, loc }) => ({
        side,
        groupId: g.id,
        ord: g.ord,
        broken: g.broken,
        reason,
        baseMsId,
        baseText: g.baseText || null,
        baseLocation: loc,
        cells: unpairedCells(g, sd, baseMsId),
    }));
    paired.sort((a, b) => a.newOrd - b.newOrd || a.oldOrd - b.oldOrd);
    return {
        paired,
        unpairedOld: toUnpaired(oldSide, oldUnmatched, 'old'),
        unpairedNew: toUnpaired(newSide, newUnmatched, 'new'),
    };
}
// ---------- 入口 ----------
function buildEditionDiff(oldView, newView, oldCreatedAt) {
    const oldSide = buildSide(oldView, 'old');
    const newSide = buildSide(newView, 'new');
    const oldMsName = oldBaseName(oldView);
    const newMsName = newBaseName(newView);
    const sides = {
        old: {
            kind: 'edition',
            editionNo: oldView.document.publishedVer,
            version: oldView.document.version,
            baseMsId: oldView.document.baseMsId,
            baseMsName: oldMsName,
            publishedVer: oldView.document.publishedVer,
            groupCount: oldView.stats.groupCount,
            brokenCount: oldView.stats.brokenCount,
            createdAt: oldCreatedAt,
        },
        new: {
            kind: 'working',
            editionNo: null,
            version: newView.document.version,
            baseMsId: newView.document.baseMsId,
            baseMsName: newMsName,
            publishedVer: newView.document.publishedVer,
            groupCount: newView.stats.groupCount,
            brokenCount: newView.stats.brokenCount,
        },
    };
    const baseSame = oldView.document.baseMsId != null &&
        oldView.document.baseMsId === newView.document.baseMsId;
    const pairingNote = baseSame
        ? '仅在两侧底本相同且底本片段位置（抄本原始行号 + 码点区间）唯一、一一对应时配对；' +
            '不凭组 ID / 组序判定增删，无法唯一配对的旧组与新组分别列于“未配对”，不推断移动。'
        : `两侧底本不同（旧版底本：${oldMsName ?? '—'}；当前工作版底本：${newMsName ?? '—'}），` +
            '旧组与新组不配对，分别列出。';
    // 抄本清单（含新增；系统不删除抄本）
    const manuscripts = [];
    const msIds = new Set([
        ...oldView.manuscripts.map((m) => m.id),
        ...newView.manuscripts.map((m) => m.id),
    ]);
    for (const msId of msIds) {
        const om = oldView.manuscripts.find((m) => m.id === msId);
        const nm = newView.manuscripts.find((m) => m.id === msId);
        manuscripts.push({
            msId,
            name: nm?.name ?? om?.name ?? `抄本#${msId}`,
            inOld: !!om,
            inNew: !!nm,
            oldPosition: om?.position ?? null,
            newPosition: nm?.position ?? null,
            isOldBase: !!om?.isBase,
            isNewBase: !!nm?.isBase,
        });
    }
    manuscripts.sort((a, b) => (a.newPosition ?? a.oldPosition ?? 0) - (b.newPosition ?? b.oldPosition ?? 0));
    const textChanges = buildTextChanges(oldSide, newSide);
    const textChangeCounts = {
        manuscriptCount: new Set(textChanges.map((t) => t.msId)).size,
        changed: textChanges.filter((t) => t.status === 'changed').length,
        added: textChanges.filter((t) => t.status === 'added').length,
        removed: textChanges.filter((t) => t.status === 'removed').length,
    };
    const { paired, unpairedOld, unpairedNew } = pairGroups(oldSide, newSide);
    return {
        documentId: newView.document.id,
        title: newView.document.title,
        generatedAt: new Date().toISOString(),
        sides,
        baseSame,
        pairingNote,
        manuscripts,
        textChanges,
        textChangeCounts,
        groupDiff: {
            paired,
            unpairedOld,
            unpairedNew,
            counts: {
                paired: paired.length,
                pairedChanged: paired.filter((p) => p.status === 'changed').length,
                unpairedOld: unpairedOld.length,
                unpairedNew: unpairedNew.length,
            },
        },
    };
}
function oldBaseName(v) {
    return v.manuscripts.find((m) => m.id === v.document.baseMsId)?.name ?? null;
}
function newBaseName(v) {
    return v.manuscripts.find((m) => m.id === v.document.baseMsId)?.name ?? null;
}
