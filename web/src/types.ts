export interface CellView {
  msId: number;
  missing: boolean;
  broken: boolean;
  lineNo?: number;
  startCp?: number;
  endCp?: number;
  text?: string;
  oobEnd?: number;
}

export interface GroupView {
  id: number;
  ord: number;
  broken: boolean;
  baseText: string;
  inverted: boolean;
  cells: CellView[];
  variant: boolean;
  hasMissing: boolean;
}

export interface CoveredSpan {
  startCp: number;
  endCp: number;
  groupId: number;
  broken: boolean;
}

export interface RawLineView {
  lineId: number;
  lineNo: number;
  content: string;
  covered: CoveredSpan[];
}

export interface CollationView {
  document: {
    id: number;
    title: string;
    version: number;
    baseMsId: number | null;
    publishedVer: number;
  };
  manuscripts: Array<{ id: number; name: string; position: number; isBase: boolean }>;
  groups: GroupView[];
  rawByMs: Array<{ msId: number; lines: RawLineView[] }>;
  stats: { manuscriptCount: number; lineCount: number; groupCount: number; brokenCount: number };
}

export interface FragmentDraft {
  msId: number;
  missing: boolean;
  lineId?: number | null;
  startCp?: number | null;
  endCp?: number | null;
}

export interface GroupDraft {
  key: string;            // 前端临时键
  ord: number;
  serverId?: number;      // 已保存组的服务端 id
  serverBroken?: boolean; // 该已保存组当前是否待修复
  fragments: FragmentDraft[];
}

export interface DocumentSummary {
  id: number;
  title: string;
  version: number;
  published_ver: number;
  base_ms_id: number | null;
  ms_count: number;
  broken_count: number;
}

export interface EditionSummary {
  id: number;
  edition_no: number;
  created_at: string;
}

// ---- 版本对照（已发布校勘版 vs 当前工作版）----

export interface DiffSideInfo {
  kind: 'edition' | 'working';
  editionNo: number | null;
  version: number;
  baseMsId: number | null;
  baseMsName: string | null;
  publishedVer: number;
  groupCount: number;
  brokenCount: number;
  createdAt?: string;
}

export interface DiffToken {
  op: 'equal' | 'added' | 'removed';
  text: string;
}

export interface LineDiff {
  msId: number;
  msName: string;
  lineNo: number;
  status: 'changed' | 'added' | 'removed';
  oldLineId: number | null;
  newLineId: number | null;
  oldText: string;
  newText: string;
  segments: DiffToken[];
}

export interface CellChange {
  msId: number;
  msName: string;
  isBase: boolean;
  oldState: 'absent' | 'missing' | 'fragment';
  newState: 'absent' | 'missing' | 'fragment';
  changes: Array<'state' | 'location' | 'text' | 'broken'>;
  textChanged: boolean;
  oldOutOfBounds: boolean;
  newOutOfBounds: boolean;
  oldText: string | null;
  newText: string | null;
  newVisibleText: string | null;
  newOobEnd: number | null;
  oldBroken: boolean;
  newBroken: boolean;
  oldLineNo: number | null;
  newLineNo: number | null;
  oldStartCp: number | null;
  newStartCp: number | null;
  oldEndCp: number | null;
  newEndCp: number | null;
}

export interface PairedGroupDiff {
  status: 'same' | 'changed';
  oldGroupId: number;
  newGroupId: number;
  oldOrd: number;
  newOrd: number;
  ordChanged: boolean;
  oldBroken: boolean;
  newBroken: boolean;
  baseMsId: number;
  baseLocation: { lineNo: number; startCp: number; endCp: number };
  cellChanges: CellChange[];
}

export interface UnpairedCell {
  msId: number;
  msName: string;
  isBase: boolean;
  state: 'absent' | 'missing' | 'fragment';
  broken: boolean;
  outOfBounds: boolean;
  text: string | null;
  visibleText: string | null;
  lineNo: number | null;
  startCp: number | null;
  endCp: number | null;
  oobEnd: number | null;
}

export interface UnpairedGroupDiff {
  side: 'old' | 'new';
  groupId: number;
  ord: number;
  broken: boolean;
  reason: 'base-differs' | 'no-base-location' | 'duplicate-location' | 'not-matched';
  baseMsId: number | null;
  baseText: string | null;
  baseLocation: { lineNo: number; startCp: number; endCp: number } | null;
  cells: UnpairedCell[];
}

export interface EditionDiff {
  documentId: number;
  title: string;
  generatedAt: string;
  sides: { old: DiffSideInfo; new: DiffSideInfo };
  baseSame: boolean;
  pairingNote: string;
  manuscripts: Array<{
    msId: number;
    name: string;
    inOld: boolean;
    inNew: boolean;
    oldPosition: number | null;
    newPosition: number | null;
    isOldBase: boolean;
    isNewBase: boolean;
  }>;
  textChanges: LineDiff[];
  textChangeCounts: { manuscriptCount: number; changed: number; added: number; removed: number };
  groupDiff: {
    paired: PairedGroupDiff[];
    unpairedOld: UnpairedGroupDiff[];
    unpairedNew: UnpairedGroupDiff[];
    counts: { paired: number; pairedChanged: number; unpairedOld: number; unpairedNew: number };
  };
}

// ---- 补配（按底本文字在目标抄本空闲区间预配片段）----

export type SupplementGroupStatus = 'unique' | 'multiple' | 'none' | 'conflict';

export interface SupplementCandidate {
  lineId: number;
  lineNo: number;
  startCp: number;
  endCp: number;
  text: string;
  conflictsWithGroupIds: number[];
}

export interface SupplementGroup {
  groupId: number;
  ord: number;
  baseText: string;
  status: SupplementGroupStatus;
  adoptable: boolean;
  reason: string;
  candidates: SupplementCandidate[];
}

export interface SupplementPreview {
  documentId: number;
  version: number;
  baseMsId: number | null;
  targetMsId: number;
  targetMsName: string;
  eligibleGroupCount: number;
  excludedGroupCount: number;
  groups: SupplementGroup[];
}

export interface SupplementSelection {
  groupId: number;
  msId: number;
  lineId: number;
  startCp: number;
  endCp: number;
}

export interface SupplementResult {
  ok: boolean;
  applied: number;
  version: number;
}

// ---- 行界调整（拆分 / 合并原始行，不改变字序）----

export type ReLineOp = 'split' | 'merge';

export type ReLineBasis =
  | { lineId: number; lineNo: number; content: string; lengthCp: number }
  | {
      leftLineId: number;
      leftLineNo: number;
      leftContent: string;
      leftLengthCp: number;
      rightLineId: number;
      rightLineNo: number;
      rightContent: string;
      rightLengthCp: number;
    };

export interface ReLinePlanLine {
  lineId: number | null;
  lineNo: number;
  oldLineNo: number;
  content: string;
  origin: 'kept' | 'shifted' | 'split-left' | 'split-right' | 'merged';
}

export interface ReLineFragmentPlan {
  fragmentId: number;
  groupId: number;
  groupOrd: number;
  groupAlreadyBroken: boolean;
  oldLineId: number;
  oldLineNo: number;
  oldStartCp: number;
  oldEndCp: number;
  status: 'unchanged' | 'moved' | 'broken';
  newLineId: number | null;
  newLineNo: number | null;
  newStartCp: number | null;
  newEndCp: number | null;
  note: string;
}

export interface ReLineBrokenGroupPlan {
  groupId: number;
  ord: number;
  newlyBroken: boolean;
  reason: string;
}

export interface ReLinePlan {
  op: ReLineOp;
  msId: number;
  msName: string;
  splitCp?: number;
  basis: ReLineBasis;
  lines: ReLinePlanLine[];
  fragments: ReLineFragmentPlan[];
  brokenGroups: ReLineBrokenGroupPlan[];
}

export interface ReLinePreview extends ReLinePlan {
  documentId: number;
  version: number;
}

export interface ReLineResult {
  ok: boolean;
  version: number;
  result: ReLinePlan;
}

// ---- 批量行改（一次校订多份抄本的多份原始行）----

export interface BatchEditItem {
  lineId: number;
  startCp: number;
  endCp: number;
  replacement: string;
}

export interface BatchEditLineBasis {
  lineId: number;
  lineNo: number;
  msId: number;
  msName: string;
  content: string;
  lengthCp: number;
}

export interface BatchEditLinePlan {
  lineId: number;
  lineNo: number;
  msId: number;
  msName: string;
  oldContent: string;
  newContent: string;
  oldLengthCp: number;
  newLengthCp: number;
  edits: Array<{
    index: number;
    startCp: number;
    endCp: number;
    replacement: string;
    replacementLengthCp: number;
  }>;
}

export interface BatchEditFragmentPlan {
  fragmentId: number;
  groupId: number;
  groupOrd: number;
  groupAlreadyBroken: boolean;
  msId: number;
  lineId: number;
  lineNo: number;
  oldStartCp: number;
  oldEndCp: number;
  status: 'unchanged' | 'moved' | 'broken';
  newStartCp: number | null;
  newEndCp: number | null;
  note: string;
}

export interface BatchEditBrokenGroup {
  groupId: number;
  ord: number;
  newlyBroken: boolean;
  reason: string;
}

export interface BatchEditPlan {
  basis: BatchEditLineBasis[];
  lines: BatchEditLinePlan[];
  fragments: BatchEditFragmentPlan[];
  brokenGroups: BatchEditBrokenGroup[];
}

export interface BatchEditPreview extends BatchEditPlan {
  documentId: number;
  version: number;
  editCount: number;
}

export interface BatchEditResult {
  ok: boolean;
  version: number;
  result: BatchEditPreview;
}

// ---- 恢复已发布校勘版 ----

export interface RestoreResult {
  ok: boolean;
  editionNo: number;
  version: number;
  restored: {
    manuscriptCount: number;
    lineCount: number;
    groupCount: number;
    fragmentCount: number;
    missingCount: number;
    baseMsId: number;
  };
}

// ---- 文献归档（导出 / 导入） ----

export interface CollationArchive {
  format: string;
  formatVersion: number;
  exportedAt: string;
  document: {
    title: string;
    version: number;
    publishedVer: number;
    baseMsRef: number | null;
  };
  manuscripts: Array<{ ref: number; name: string; position: number }>;
  lines: Array<{ ref: number; msRef: number; lineNo: number; content: string }>;
  groups: Array<{
    ord: number;
    broken: boolean;
    fragments: Array<{
      msRef: number;
      missing: boolean;
      lineRef: number | null;
      startCp: number | null;
      endCp: number | null;
    }>;
  }>;
  editions: Array<{ editionNo: number; createdAt: string | null; snapshot: unknown }>;
}

export interface ImportArchiveResult {
  ok: boolean;
  documentId: number;
  title: string;
  version: number;
  publishedVer: number;
  imported: {
    manuscriptCount: number;
    lineCount: number;
    groupCount: number;
    brokenGroupCount: number;
    fragmentCount: number;
    missingCount: number;
    editionCount: number;
  };
}
