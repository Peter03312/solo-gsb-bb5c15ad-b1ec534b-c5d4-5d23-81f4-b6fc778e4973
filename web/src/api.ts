// 前端 API 封装：所有写请求带 expectedVersion；409 抛出过期版本错误。

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let details: unknown;
    try {
      const j = await res.json();
      msg = j.error || msg;
      details = j.details;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg, details);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  listDocuments: () => req<{ documents: DocumentSummary[] }>('GET', '/api/documents'),
  createDocument: (title: string, manuscripts: string[]) =>
    req<{ id: number }>('POST', '/api/documents', { title, manuscripts }),
  getDocument: (id: number) => req<CollationView>('GET', `/api/documents/${id}`),
  addManuscript: (id: number, expectedVersion: number, name: string) =>
    req('POST', `/api/documents/${id}/manuscripts`, { expectedVersion, name }),
  setBase: (id: number, expectedVersion: number, msId: number) =>
    req('PUT', `/api/documents/${id}/base`, { expectedVersion, msId }),
  addLine: (msId: number, expectedVersion: number, content: string) =>
    req('POST', `/api/manuscripts/${msId}/lines`, { expectedVersion, content }),
  editLine: (lineId: number, expectedVersion: number, startCp: number, endCp: number, replacement: string) =>
    req('PUT', `/api/lines/${lineId}`, { expectedVersion, startCp, endCp, replacement }),
  saveGroups: (id: number, expectedVersion: number, groups: unknown) =>
    req('PUT', `/api/documents/${id}/groups`, { expectedVersion, groups }),
  repairGroup: (id: number, groupId: number, expectedVersion: number, group: unknown) =>
    req('PUT', `/api/documents/${id}/groups/${groupId}/repair`, { expectedVersion, group }),
  deleteGroup: (id: number, groupId: number, expectedVersion: number) =>
    req('DELETE', `/api/documents/${id}/groups/${groupId}`, { expectedVersion }),
  publish: (id: number, expectedVersion: number) =>
    req<{ editionNo: number }>('POST', `/api/documents/${id}/publish`, { expectedVersion }),
  listEditions: (id: number) =>
    req<{ editions: EditionSummary[] }>('GET', `/api/documents/${id}/editions`),
  getEdition: (id: number, no: number) =>
    req<{ editionNo: number; createdAt: string; view: CollationView }>(
      'GET',
      `/api/documents/${id}/editions/${no}`
    ),
  getEditionDiff: (id: number, no: number) =>
    req<EditionDiff>('GET', `/api/documents/${id}/editions/${no}/diff`),
  restoreEdition: (id: number, no: number, expectedVersion: number) =>
    req<RestoreResult>(
      'POST',
      `/api/documents/${id}/editions/${no}/restore`,
      { expectedVersion }
    ),
  supplementPreview: (id: number, targetMsId: number) =>
    req<SupplementPreview>('GET', `/api/documents/${id}/supplement/preview?targetMsId=${targetMsId}`),
  supplementCommit: (
    id: number,
    expectedVersion: number,
    targetMsId: number,
    selections: SupplementSelection[]
  ) =>
    req<SupplementResult>('POST', `/api/documents/${id}/supplement`, {
      expectedVersion,
      targetMsId,
      selections,
    }),
  relinePreviewSplit: (id: number, lineId: number, splitCp: number) =>
    req<ReLinePreview>('GET', `/api/documents/${id}/reline/preview?op=split&lineId=${lineId}&splitCp=${splitCp}`),
  relinePreviewMerge: (id: number, leftLineId: number, rightLineId: number) =>
    req<ReLinePreview>(
      'GET',
      `/api/documents/${id}/reline/preview?op=merge&leftLineId=${leftLineId}&rightLineId=${rightLineId}`
    ),
  relineCommit: (
    id: number,
    expectedVersion: number,
    body:
      | { op: 'split'; lineId: number; splitCp: number; basis: ReLineBasis }
      | { op: 'merge'; leftLineId: number; rightLineId: number; basis: ReLineBasis }
  ) => req<ReLineResult>('POST', `/api/documents/${id}/reline`, { expectedVersion, ...body }),
  batchEditPreview: (id: number, edits: BatchEditItem[]) =>
    req<BatchEditPreview>('POST', `/api/documents/${id}/lines/batch-edit/preview`, { edits }),
  batchEditCommit: (
    id: number,
    expectedVersion: number,
    edits: BatchEditItem[],
    basis: unknown
  ) =>
    req<BatchEditResult>('POST', `/api/documents/${id}/lines/batch-edit`, {
      expectedVersion,
      edits,
      basis,
    }),
  exportArchive: (id: number) => req<CollationArchive>('GET', `/api/documents/${id}/archive`),
  importArchive: (archive: unknown) =>
    req<ImportArchiveResult>('POST', '/api/documents/import', archive),
};

import type {
  BatchEditItem,
  BatchEditPreview,
  BatchEditResult,
  CollationArchive,
  CollationView,
  DocumentSummary,
  EditionDiff,
  EditionSummary,
  ImportArchiveResult,
  ReLineBasis,
  ReLinePreview,
  ReLineResult,
  RestoreResult,
  SupplementPreview,
  SupplementResult,
  SupplementSelection,
} from './types';
