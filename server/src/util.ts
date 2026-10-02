/** 所有字符位置均以 Unicode 码点计（生僻字 / 扩展 B/C/D/E/F 区安全），区间左闭右开。 */

export class HttpError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function chars(s: string): string[] {
  return Array.from(s);
}

export function charLen(s: string): number {
  return Array.from(s).length;
}

export function sliceCp(s: string, start: number, end: number): string {
  return Array.from(s).slice(start, end).join('');
}

export function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** [aStart,aEnd) 与 [bStart,bEnd) 是否相交（端点相接不算重叠）。 */
export function rangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart < bEnd && bStart < aEnd;
}
