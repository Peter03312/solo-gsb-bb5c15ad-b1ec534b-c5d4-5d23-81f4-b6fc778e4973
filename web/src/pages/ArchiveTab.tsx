import { useRef, useState } from 'react';
import { api } from '../api';
import type { CollationView, ImportArchiveResult } from '../types';

/**
 * 归档页签：把本文献下载为可迁移归档；把归档导入为另一篇独立文献。
 *  - 导出：同一已提交版本的一致性快照（含标题、抄本及行序、底本、当前对应组、
 *    缺文与待修复状态、工作版版本号、全部已发布版快照），文件带格式版本；
 *  - 导入：服务端单次事务校验并重建全部内部标识；源文献不受影响，
 *    同一文件可重复导入，各自生成独立文献；失败时在此展示可定位的错误原因。
 */
export function ArchiveTab({
  view,
  onError,
  onNotice,
  onOpenDocument,
}: {
  view: CollationView;
  onError: (msg: string, details?: unknown) => void;
  onNotice: (msg: string) => void;
  onOpenDocument: (id: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<ImportArchiveResult | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const doExport = async () => {
    setBusy(true);
    try {
      const archive = await api.exportArchive(view.document.id);
      const blob = new Blob([JSON.stringify(archive, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${view.document.title}-v${archive.document.version}.collation.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onNotice(
        `归档已下载：工作版 v${archive.document.version}，含 ${archive.editions.length} 个已发布版快照` +
          `（格式 ${archive.format} v${archive.formatVersion}）。`
      );
    } catch (e) {
      onError((e as Error).message, (e as { details?: unknown }).details);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async (file: File) => {
    setImported(null);
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      onError(`归档文件不是合法 JSON：${(e as Error).message}`);
      return;
    }
    setBusy(true);
    try {
      const r = await api.importArchive(data);
      setImported(r);
      onNotice(`归档已导入为新文献 #${r.documentId}「${r.title}」（源文献不受影响）。`);
    } catch (e) {
      onError((e as Error).message, (e as { details?: unknown }).details);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div>
      <div className="card">
        <h2>导出归档</h2>
        <div className="muted" style={{ marginBottom: 10 }}>
          把本文献当前工作版（v{view.document.version}）连同全部 {view.document.publishedVer}{' '}
          个已发布版快照打包为一个可迁移的 JSON 归档文件；导出为只读操作，不推进版本。
          归档含：标题、抄本及行序、底本、当前对应组片段、缺文与待修复状态、工作版版本号、
          全部已发布版快照，并带格式版本号。
        </div>
        <button className="primary" disabled={busy} onClick={doExport}>
          {busy ? '处理中…' : '下载归档文件（.json）'}
        </button>
      </div>

      <div className="card">
        <h2>导入归档</h2>
        <div className="muted" style={{ marginBottom: 10 }}>
          选择先前导出的归档文件（.json），将其导入为<strong>另一篇独立文献</strong>：
          全部内部标识重建，源文献不受影响；同一文件可重复导入，各自独立。
          导入在单次事务中校验格式与引用关系——未知格式、缺失引用、损坏快照、
          完好组非法区间等都会逐条给出原因并整次拒绝。
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void doImport(f);
          }}
        />
        {imported && (
          <div className="ok-box" style={{ marginTop: 10 }}>
            <div>
              ✓ 已导入为文献 #{imported.documentId}「{imported.title}」：抄本{' '}
              {imported.imported.manuscriptCount} 份 · 行 {imported.imported.lineCount} 条 · 对应组{' '}
              {imported.imported.groupCount} 个（待修复 {imported.imported.brokenGroupCount}）· 片段{' '}
              {imported.imported.fragmentCount} 条（缺文 {imported.imported.missingCount}）· 已发布版{' '}
              {imported.imported.editionCount} 个；工作版 v{imported.version}，已发布至第{' '}
              {imported.publishedVer} 版。
            </div>
            <div style={{ marginTop: 8 }}>
              <button className="primary" onClick={() => onOpenDocument(imported.documentId)}>
                打开新文献
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
