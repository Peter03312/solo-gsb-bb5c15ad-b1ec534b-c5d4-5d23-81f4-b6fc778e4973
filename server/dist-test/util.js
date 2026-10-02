"use strict";
/** 所有字符位置均以 Unicode 码点计（生僻字 / 扩展 B/C/D/E/F 区安全），区间左闭右开。 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpError = void 0;
exports.chars = chars;
exports.charLen = charLen;
exports.sliceCp = sliceCp;
exports.isInt = isInt;
exports.rangesOverlap = rangesOverlap;
class HttpError extends Error {
    constructor(status, message, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}
exports.HttpError = HttpError;
function chars(s) {
    return Array.from(s);
}
function charLen(s) {
    return Array.from(s).length;
}
function sliceCp(s, start, end) {
    return Array.from(s).slice(start, end).join('');
}
function isInt(v) {
    return typeof v === 'number' && Number.isInteger(v);
}
/** [aStart,aEnd) 与 [bStart,bEnd) 是否相交（端点相接不算重叠）。 */
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
}
