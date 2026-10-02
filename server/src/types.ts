// 数据库行类型
export interface DocumentRow {
  id: number;
  title: string;
  base_ms_id: number | null;
  version: number;
  published_ver: number;
}

export interface ManuscriptRow {
  id: number;
  doc_id: number;
  name: string;
  position: number;
}

export interface LineRow {
  id: number;
  ms_id: number;
  line_no: number;
  content: string;
}

export interface GroupRow {
  id: number;
  doc_id: number;
  ord: number;
  broken: boolean;
}

export interface FragmentRow {
  id: number;
  group_id: number;
  doc_id: number;
  ms_id: number;
  line_id: number | null;
  start_cp: number | null;
  end_cp: number | null;
  missing: boolean;
}

// ---- 补配：按完好对应组的底本文字，在目标抄本原始行文的空闲区间里预配片段 ----

export type SupplementGroupStatus = 'unique' | 'multiple' | 'none' | 'conflict';

export interface SupplementCandidate {
  lineId: number;
  lineNo: number;
  startCp: number;              // Unicode 码点偏移（左闭）
  endCp: number;                // Unicode 码点偏移（右开）
  text: string;                 // 必与底本文字完整相同
  /** 与其他组候选在同一行区间重叠时，那些组的 id（同组多处候选互不列入）。 */
  conflictsWithGroupIds: number[];
}

export interface SupplementGroup {
  groupId: number;
  ord: number;
  baseText: string;
  /** unique=候选唯一且无冲突（可直接采纳）；multiple=多处；none=无；conflict=唯一但与他组候选重叠。 */
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
  /** 纳入补配考虑的完好组数（目标抄本无片段且未标缺文）。 */
  eligibleGroupCount: number;
  /** 未纳入的组数：待修复 / 已有片段 / 已标缺文 / 底本文字不可用。 */
  excludedGroupCount: number;
  groups: SupplementGroup[];
}

export interface SupplementSelectionDTO {
  groupId: number;
  msId: number;
  lineId: number;
  startCp: number;
  endCp: number;
}

export interface EditionRow {
  id: number;
  doc_id: number;
  edition_no: number;
  snapshot: CollationView;
  created_at: string;
}

// ---- 行界调整（拆分 / 合并原始行，不改变字序）----

export type ReLineOp = 'split' | 'merge';

/**
 * 预览所依据的行状态：提交时须原样带回。
 * 若提交时这些行已变化（内容 / 行号被他人改动），整次拒绝（409 RELINE_STALE）。
 */
export interface ReLineSplitBasis {
  lineId: number;
  lineNo: number;
  content: string;
  lengthCp: number;
}

export interface ReLineMergeBasis {
  leftLineId: number;
  leftLineNo: number;
  leftContent: string;
  leftLengthCp: number;
  rightLineId: number;
  rightLineNo: number;
  rightContent: string;
  rightLengthCp: number;
}

export type ReLineBasis = ReLineSplitBasis | ReLineMergeBasis;

/** 调整后该抄本的一行（行序预览）。 */
export interface ReLinePlanLine {
  lineId: number | null;      // 拆分出的新行在预览时暂无 id（提交成功后回填）
  lineNo: number;             // 调整后的原始行号
  oldLineNo: number;          // 调整前的原始行号
  content: string;
  origin: 'kept' | 'shifted' | 'split-left' | 'split-right' | 'merged';
}

export type ReLineFragmentStatus = 'unchanged' | 'moved' | 'broken';

/** 受影响片段的新位置（跨拆分点片段保留可追溯定位并标待修复）。 */
export interface ReLineFragmentPlan {
  fragmentId: number;
  groupId: number;
  groupOrd: number;
  groupAlreadyBroken: boolean; // 组当前是否已待修复（调整后绝不自动转完好）
  oldLineId: number;
  oldLineNo: number;
  oldStartCp: number;
  oldEndCp: number;
  status: ReLineFragmentStatus;
  newLineId: number | null;    // 拆分右段的新行在预览时为 null（提交后回填）
  newLineNo: number | null;
  newStartCp: number | null;
  newEndCp: number | null;
  note: string;
}

export interface ReLineBrokenGroupPlan {
  groupId: number;
  ord: number;
  newlyBroken: boolean;        // false=原已待修复，调整后仍保持（不自动转完好）
  reason: string;
}

export interface ReLinePlan {
  op: ReLineOp;
  msId: number;
  msName: string;
  splitCp?: number;            // 仅拆分：拆分点（码点；该码点起的字归入右段）
  basis: ReLineBasis;
  lines: ReLinePlanLine[];
  fragments: ReLineFragmentPlan[];
  brokenGroups: ReLineBrokenGroupPlan[];
}

export interface ReLinePreview extends ReLinePlan {
  documentId: number;
  version: number;
}

// ---- 批量行改（一次校订同一文献多份抄本的多份原始行；先预览、再凭版本确认）----

export interface BatchEditDTO {
  lineId: number;
  startCp: number;              // Unicode 码点偏移（左闭，按改前原文计算）
  endCp: number;                // 右开；startCp=endCp 为插入点
  replacement: string;          // 替换文字（空串=删除）
}

/** 预览所依据的行状态（每个被改行一条）：提交时须原样带回。 */
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
  /** 本行命中的编辑（按原坐标排序，index 为请求列表中的下标）。 */
  edits: Array<{
    index: number;
    startCp: number;
    endCp: number;
    replacement: string;
    replacementLengthCp: number;
  }>;
}

export type BatchEditFragmentStatus = 'unchanged' | 'moved' | 'broken';

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
  status: BatchEditFragmentStatus;
  /** 相交改动保留原区间坐标以便追溯（与现行单行改字一致），故此时与旧坐标相同。 */
  newStartCp: number | null;
  newEndCp: number | null;
  note: string;
}

export interface BatchEditBrokenGroup {
  groupId: number;
  ord: number;
  newlyBroken: boolean;         // false=原已待修复（批量改字不得自动转好）
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

// ---- 对外（API / 前端）类型 ----

export interface FragmentDTO {
  msId: number;
  missing: boolean;
  lineId?: number | null;
  startCp?: number | null;
  endCp?: number | null;
}

export interface GroupDTO {
  id?: number;
  ord: number;
  fragments: FragmentDTO[];
}

/** 组在某抄本上的呈现片段（读模型，运行时派生）。 */
export interface CellView {
  msId: number;
  missing: boolean;          // 显式缺文
  broken: boolean;           // 原文改动后越界 / 底本已变 → 待修复
  lineNo?: number;
  startCp?: number;
  endCp?: number;
  text?: string;             // 当前原文截取；越界时为越界前可见部分
  oobEnd?: number;           // endCp 超过当前行长时的实际行长
}

export interface GroupView {
  id: number;
  ord: number;
  broken: boolean;
  baseText: string;          // 底本片段文字（底本缺失则为空串）
  inverted: boolean;         // 相对底本顺序的倒置
  cells: CellView[];
  variant: boolean;          // 存在异文
  hasMissing: boolean;       // 存在显式缺文
}

export interface RawLineView {
  lineId: number;
  lineNo: number;
  content: string;
  // 已被有效片段覆盖的码点区间（用于下划线标识），互不重叠
  covered: Array<{ startCp: number; endCp: number; groupId: number; broken: boolean }>;
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
  /** 各抄本原始行序视图（含未归组文字）。 */
  rawByMs: Array<{ msId: number; lines: RawLineView[] }>;
  stats: {
    manuscriptCount: number;
    lineCount: number;
    groupCount: number;
    brokenCount: number;
  };
}

// ---- 文献归档（导出为可迁移文件 / 导入为另一篇文献）----

/**
 * 可迁移归档格式（format="collation-archive"，formatVersion=1）。
 * 归档内的 id 均为「归档局部引用」（导出时取源库 id），导入时全部重建为新标识，
 * 与任何现存文献互不干扰；同一文件可重复导入，各自生成独立文献。
 */
export interface ArchiveManuscript {
  ref: number;                // 抄本引用（归档局部）
  name: string;
  position: number;           // 展示次序（自 1 连续）
}

export interface ArchiveLine {
  ref: number;                // 行引用（归档局部）
  msRef: number;              // 所属抄本引用
  lineNo: number;             // 该抄本内原始行号（自 1 连续）
  content: string;
}

export interface ArchiveFragment {
  msRef: number;
  missing: boolean;           // 显式缺文标记（不依附行）
  lineRef: number | null;     // 真实片段：行引用；缺文时为 null
  startCp: number | null;     // Unicode 码点偏移（左闭）
  endCp: number | null;       // 右开；待修复组可保留越界坐标
}

export interface ArchiveGroup {
  ord: number;                // 底本顺序（自 1 连续）
  broken: boolean;            // 待修复状态
  fragments: ArchiveFragment[];
}

export interface ArchiveEdition {
  editionNo: number;          // 发布版编号（自 1 连续）
  createdAt: string | null;   // 发布时间（ISO）
  snapshot: unknown;          // 发布定稿快照（CollationView）
}

export interface CollationArchive {
  format: string;             // 固定 "collation-archive"
  formatVersion: number;      // 当前为 1
  exportedAt: string;         // 导出时刻（ISO，仅元信息）
  document: {
    title: string;
    version: number;          // 导出时工作版版本号（同一已提交版本的一致性读）
    publishedVer: number;     // 已发布版序号
    baseMsRef: number | null; // 底本抄本引用
  };
  manuscripts: ArchiveManuscript[];
  lines: ArchiveLine[];
  groups: ArchiveGroup[];
  editions: ArchiveEdition[];
}

// ---- 版本对照（任一已发布校勘版 vs 当前工作版）----

export interface DiffSideInfo {
  kind: 'edition' | 'working';
  editionNo: number | null;          // 工作版为 null
  version: number;                   // 乐观锁版本号（快照侧为发布当时版本）
  baseMsId: number | null;
  baseMsName: string | null;
  publishedVer: number;
  groupCount: number;
  brokenCount: number;
  createdAt?: string;                // 旧版发布时间
}

export type DiffTokenOp = 'equal' | 'added' | 'removed';

export interface DiffToken {
  op: DiffTokenOp;
  text: string;
}

/** 行文增删改：按抄本 + 该抄本原始行号呈现。 */
export interface LineDiff {
  msId: number;
  msName: string;
  lineNo: number;
  status: 'changed' | 'added' | 'removed';
  oldLineId: number | null;
  newLineId: number | null;
  oldText: string;
  newText: string;
  segments: DiffToken[];             // 码点级 LCS 增删改片段
}

export type CellStateKind = 'absent' | 'missing' | 'fragment';

export interface CellChange {
  msId: number;
  msName: string;
  isBase: boolean;
  oldState: CellStateKind;
  newState: CellStateKind;
  /** 变化项：state=片段有无/缺文切换；location=行号或码点区间；text=确定文字；broken=待修复状态 */
  changes: Array<'state' | 'location' | 'text' | 'broken'>;
  /** 仅当两侧片段均在行内（非越界/失效）时才对确定文字下结论。 */
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
  /** 两侧唯一对应的底本片段位置（配对依据）。 */
  baseLocation: { lineNo: number; startCp: number; endCp: number };
  cellChanges: CellChange[];
}

export interface UnpairedCell {
  msId: number;
  msName: string;
  isBase: boolean;
  state: CellStateKind;
  broken: boolean;
  /** 片段自身越界 / 引用失效（其文字不得作为确定文字）。 */
  outOfBounds: boolean;
  /** 行内片段的确定文字；越界/失效时为 null。 */
  text: string | null;
  /** 越界前尚可见的文字（不确定，仅供参考）。 */
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
  /**
   * 未配对原因：
   * base-differs 两侧底本不同；no-base-location 该侧无可用底本片段位置；
   * duplicate-location 同一底本位置在该侧不唯一；not-matched 另一侧无同位置组。
   */
  reason: 'base-differs' | 'no-base-location' | 'duplicate-location' | 'not-matched';
  baseMsId: number | null;
  baseText: string | null;
  baseLocation: { lineNo: number; startCp: number; endCp: number } | null;
  cells: UnpairedCell[];
}

export interface EditionDiff {
  documentId: number;
  title: string;
  /** 服务端生成时刻：刷新对照即可获得当前最新工作版结果。 */
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
