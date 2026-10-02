/** 渲染服务端返回的校验问题（含位置与原因）。 */
export function ErrorBox({ message, issues }: { message: string; issues?: unknown }) {
  let list: Array<Record<string, unknown>> = [];
  if (Array.isArray(issues)) {
    list = issues as Array<Record<string, unknown>>;
  } else if (
    issues &&
    typeof issues === 'object' &&
    Array.isArray((issues as { issues?: unknown }).issues)
  ) {
    // details 形如 { code, issues: [...] }（如 ARCHIVE_INVALID / SUPPLEMENT_STALE）
    list = (issues as { issues: Array<Record<string, unknown>> }).issues;
  }
  return (
    <div className="error-box">
      <div>⛔ {message}</div>
      {list.length > 0 && (
        <ul style={{ margin: '6px 0 0 18px' }}>
          {list.map((it, i) => (
            <li key={i}>{String(it.message ?? it.code ?? '校验未通过')}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
