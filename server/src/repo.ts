import { PoolClient } from 'pg';
import { DocumentRow, LineRow, ManuscriptRow } from './types';
import { HttpError } from './util';

/** 取文献行并加锁；不存在 → 404。 */
export async function lockDoc(client: PoolClient, id: number): Promise<DocumentRow> {
  const { rows } = await client.query<DocumentRow>(
    'SELECT id, title, base_ms_id, version, published_ver FROM documents WHERE id=$1 FOR UPDATE',
    [id]
  );
  if (rows.length === 0) throw new HttpError(404, `文献 #${id} 不存在`);
  return rows[0];
}

export async function getDoc(client: PoolClient, id: number): Promise<DocumentRow> {
  const { rows } = await client.query<DocumentRow>(
    'SELECT id, title, base_ms_id, version, published_ver FROM documents WHERE id=$1',
    [id]
  );
  if (rows.length === 0) throw new HttpError(404, `文献 #${id} 不存在`);
  return rows[0];
}

export async function loadMss(client: PoolClient, docId: number): Promise<ManuscriptRow[]> {
  const { rows } = await client.query<ManuscriptRow>(
    'SELECT id, doc_id, name, position FROM manuscripts WHERE doc_id=$1 ORDER BY position, id',
    [docId]
  );
  return rows;
}

export async function loadLines(client: PoolClient, msIds: number[]): Promise<LineRow[]> {
  if (msIds.length === 0) return [];
  const { rows } = await client.query<LineRow>(
    'SELECT id, ms_id, line_no, content FROM lines WHERE ms_id = ANY($1::bigint[])',
    [msIds]
  );
  return rows;
}

/**
 * 乐观锁：所有修改请求必须携带 expectedVersion；
 * 过期版本 → 409 拒绝（不做任何写入）。
 */
export function checkVersion(doc: DocumentRow, expected: unknown): void {
  if (typeof expected !== 'number' || !Number.isInteger(expected)) {
    throw new HttpError(400, '缺少 expectedVersion（整数），无法进行并发控制');
  }
  if (expected !== doc.version) {
    throw new HttpError(
      409,
      `版本已过期：您基于版本 ${expected} 修改，当前版本为 ${doc.version}，请刷新后重试`,
      { currentVersion: doc.version }
    );
  }
}

export async function bumpVersion(client: PoolClient, docId: number): Promise<void> {
  await client.query('UPDATE documents SET version = version + 1 WHERE id=$1', [docId]);
}
