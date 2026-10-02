"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.lockDoc = lockDoc;
exports.getDoc = getDoc;
exports.loadMss = loadMss;
exports.loadLines = loadLines;
exports.checkVersion = checkVersion;
exports.bumpVersion = bumpVersion;
const util_1 = require("./util");
/** 取文献行并加锁；不存在 → 404。 */
async function lockDoc(client, id) {
    const { rows } = await client.query('SELECT id, title, base_ms_id, version, published_ver FROM documents WHERE id=$1 FOR UPDATE', [id]);
    if (rows.length === 0)
        throw new util_1.HttpError(404, `文献 #${id} 不存在`);
    return rows[0];
}
async function getDoc(client, id) {
    const { rows } = await client.query('SELECT id, title, base_ms_id, version, published_ver FROM documents WHERE id=$1', [id]);
    if (rows.length === 0)
        throw new util_1.HttpError(404, `文献 #${id} 不存在`);
    return rows[0];
}
async function loadMss(client, docId) {
    const { rows } = await client.query('SELECT id, doc_id, name, position FROM manuscripts WHERE doc_id=$1 ORDER BY position, id', [docId]);
    return rows;
}
async function loadLines(client, msIds) {
    if (msIds.length === 0)
        return [];
    const { rows } = await client.query('SELECT id, ms_id, line_no, content FROM lines WHERE ms_id = ANY($1::bigint[])', [msIds]);
    return rows;
}
/**
 * 乐观锁：所有修改请求必须携带 expectedVersion；
 * 过期版本 → 409 拒绝（不做任何写入）。
 */
function checkVersion(doc, expected) {
    if (typeof expected !== 'number' || !Number.isInteger(expected)) {
        throw new util_1.HttpError(400, '缺少 expectedVersion（整数），无法进行并发控制');
    }
    if (expected !== doc.version) {
        throw new util_1.HttpError(409, `版本已过期：您基于版本 ${expected} 修改，当前版本为 ${doc.version}，请刷新后重试`, { currentVersion: doc.version });
    }
}
async function bumpVersion(client, docId) {
    await client.query('UPDATE documents SET version = version + 1 WHERE id=$1', [docId]);
}
