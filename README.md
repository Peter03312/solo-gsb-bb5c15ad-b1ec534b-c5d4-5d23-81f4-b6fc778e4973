# 多抄本校勘 Web 应用（古籍整理）

面向古籍整理团队的多抄本对校工具：对同一篇文献录入 **至少两份抄本** 的逐行文字，
选定 **底本**，将行内连续字句编入 **对应组**；自动呈现异文、缺文、倒置与未归组文字，
并提供「待修复 → 修复 → 发布」的版本化工作流。

技术栈：**Node.js + TypeScript（Express）· React 18 + Vite · PostgreSQL 16**。

---

## 一、一键启动（Docker，推荐）

前置：已安装 Docker 与 Docker Compose v2。

```bash
docker compose up -d --build
```

启动后打开浏览器：

> **http://localhost:4000**

- 端口可通过环境变量 `APP_PORT` 修改（默认 `4000`）；
- 首次启动自动：建库、建表（`db/schema.sql`）、安装全部依赖、构建前端；
- 数据持久化于命名卷 `collation-pgdata`。

常用命令：

```bash
docker compose logs -f app      # 查看应用日志
docker compose down             # 停止（保留数据）
docker compose down -v          # 停止并删除数据库数据
```

### 配置（可选）

复制 `.env.example` 为 `.env` 后修改：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_PORT` | `4000` | 浏览器访问端口（宿主机） |
| `PGUSER` | `collation` | 数据库用户 |
| `PGPASSWORD` | `collation` | 数据库密码 |
| `PGDATABASE` | `collation` | 数据库名 |

---

## 二、本地开发（不用 Docker）

需要本机已有 PostgreSQL 13+，并预先创建数据库：

```bash
createdb collation
# 表结构由后端启动时自动执行 db/schema.sql 建好；也可手动：
# psql -d collation -f db/schema.sql
```

启动后端（终端 1）：

```bash
cd server
npm install
npm run dev          # http://localhost:4000，热重载
```

启动前端（终端 2）：

```bash
cd web
npm install
npm run dev          # http://localhost:5173 （/api 自动代理到 4000）
```

开发模式请打开 **http://localhost:5173**；生产模式仅暴露 **4000**（Express 托管前端产物）。

后端环境变量（均有默认值）：`PGHOST=localhost PGPORT=5432 PGUSER=collation PGPASSWORD=collation PGDATABASE=collation PORT=4000`。

---

## 三、业务规则与功能

### 录文
- 每份抄本按 **原始行序逐行录入**；新增抄本不限份数。
- 在行文中鼠标拖选连续字句即可就地 **改字**（替换 / 插入 / 删除，删除即替换框留空）。
- 字符位置以 **Unicode 码点** 计，生僻字、扩展区汉字（𫬺、𰻞等）安全。

### 归组规则（保存时强校验，任一不满足即整体拒绝、**绝不部分保存**）
1. 每组 **必须且仅含一个底本片段**（底本片段不能标缺文）；
2. 其他抄本 **每组至多占一个片段**，或对该组显式 **标为缺文**；
3. 同一抄本的片段 **不得在行内重叠归组**（端点相接允许）；
4. 片段不得 **越界**（起点/终点超出该行当前字数）。

校验失败时错误信息逐条给出 **位置与原因**，例如：

> 第 2 组「乙本」越界：该行共 10 字，片段位于第 1 行第 6–99 字；合法范围为第 1–10 字
> 抄本「乙本」第 1 行存在重叠归组：第 1 组 [1, 6) 与第 2 组 [6, 11) 在第 6 字重叠…

组序（底本顺序）必须自 1 连续。

### 对照页
- 上半部 **依底本顺序** 列出每个对应组，自动标注 **异文 / 缺文 / 倒置**；
- 下半部按各抄本 **原始行序** 展示全文：已归组文字加底色，**未归组文字自然完整可见**。

### 改动原文与待修复
- 修改原文时，只有 **受影响** 的对应组变为待修复：
  与改动区间相交、或改动缩短行后导致片段越界的组；
  改动点之后的片段自动平移，不受影响的组保持完好。
- 切换底本后，不含新底本片段的组全部待修复。
- **修复前不得发布新校勘版**；待修复组需逐组重录并通过同一套校验。

### 补配（按底本文字，在目标抄本空闲区间预配片段）
工作区「补配」页签（也可直接调 HTTP API）：选定**文献与目标抄本**后，按**完好对应组的底本文字**，
在该抄本**原始行文**中预览补配候选。

- **纳入范围**：仅考虑该抄本**尚无片段且未标缺文**的完好组；**待修复组不参与补配**
  （该抄本已有片段 / 已标缺文 / 底本文字不可用的组在响应中计入 `excludedGroupCount`，不返回候选）。
- **候选判定**：必须是该抄本**某一单行内**与底本文字**逐码点完整相同**的文字，
  按 Unicode 码点返回 `lineId/lineNo/startCp/endCp`（左闭右开），且**不占用任何现有片段区间**
  （含待修复组现存片段；端点相接不算占用）。
- **每组状态与原因**：
  - `unique`：候选**唯一且无冲突** → `adoptable=true`，可直接采纳；
  - `multiple`：空闲位置有多处相同文字 → 由人选一处或跳过；
  - `conflict`：候选唯一，但其区间与**其他组**候选区间在同一行重叠（候选上给 `conflictsWithGroupIds`）；
  - `none`：空闲区间内无相同文字。每组都带中文 `reason`。
- **提交**：提交所选候选及**预览时的文献版本号**。服务端在**当前工作版**重新核对
  组仍存在且完好、该抄本仍无片段且未标缺文、区间合法且落在自己行内、文字仍等于底本文字、
  不占现存片段区间，并对“其余完好组 + 采纳后的组”跑**同一套归组规则全量校验**，
  **整批通过才写入**；未选组与已有片段一律保留。
  - 版本过期（`expectedVersion` ≠ 当前版本）→ **409**，不写入；
  - 候选在当前版核对失败（组已删 / 已待修复 / 已有片段 / 已标缺文 / 行已变 / 越界 / 文字已变 /
    区间被占 / 同批候选彼此重叠）→ **409**，`details.code=SUPPLEMENT_STALE`、`details.issues[]`
    逐条给出 `code` 与位置（组序 / 行号 / 码点区间），**拒绝整批且不推进版本**；
  - 请求体本身非法（缺字段、区间非法、同组给多个候选、空 `selections`）→ 400。
  - **成功后文献版本只推进一次**，返回 `{ ok, applied, version }`。

接口：

```bash
# 预览（只读，不推进版本）
curl 'http://localhost:4000/api/documents/1/supplement/preview?targetMsId=2'
# 提交所选候选（携带预览响应里的 version）
curl -X POST http://localhost:4000/api/documents/1/supplement \
  -H 'Content-Type: application/json' \
  -d '{
    "expectedVersion": 7,
    "targetMsId": 2,
    "selections": [
      { "groupId": 11, "msId": 2, "lineId": 15, "startCp": 0, "endCp": 5 }
    ]
  }'
```

预览返回：`version/baseMsId/targetMsId/targetMsName`、`eligibleGroupCount/excludedGroupCount`、
`groups[]`（每组 `groupId/ord/baseText/status/adoptable/reason/candidates[]`，
候选含 `lineId/lineNo/startCp/endCp/text/conflictsWithGroupIds`）。

### 批量行改（一次校订多份抄本的多份原始行）
校勘人员可一次提交对**同一文献多份抄本多份原始行**的多处改字（工作区「批量改字」页签，
也可直接调 HTTP API）：输入**文献版本号**（提交时）与**非空编辑列表**，每项给出
`lineId`、按**改前原文**计算的 Unicode 码点**左闭右开区间** `[startCp,endCp)` 及
`replacement`（`startCp=endCp` 为插入，`replacement` 为空串即删除）。一律「先预览、再凭文献版本确认」：

- **预览（只读，不推进版本）**：返回**各行新文字**（`lines[]`：改前/改后内容、字数、本行命中编辑）、
  **片段新位置**（`fragments[]`：`unchanged` 原位 / `moved` 按累计位移平移 / `broken` 待修复）、
  **受影响组**（`brokenGroups[]`，区分「新标待修复」与「原已待修复」），以及提交时须原样带回的
  `basis` 与当前文献 `version`。
- **同一行的编辑按原坐标同时生效**：区间**重叠**（端点相接允许）、**同点重复插入**、
  插入点落在其他编辑区间**内部及端点**均**整批拒绝**；非法区间、**跨文献行**同样整批报错，
  `details[]` 逐条给出 `code`（`BAD_SHAPE/BAD_RANGE/LINE_NOT_IN_DOC/OVERLAPPING_RANGES/
  DUPLICATE_INSERTION/INSERTION_POINT_IN_INTERVAL`）与位置（请求项下标 / 行号 / 行 id / 码点）。
- **片段规则（与单行改字一致，逐编辑按累计位移重放）**：
  - 插入点**严格位于片段内部**才令所在组待修复；位于片段**边界**时仅平移后续片段；
  - 其他改动与片段**相交**、或片段**迁移后越界**（缩行）也令组待修复（坐标保留可追溯）；
  - 未受影响片段按**累计位移**更新；**原已待修复组与显式缺文状态不得自动改好**
    （缺文标记不依附行，批量行改永不触及）。
- **提交**：携带 `expectedVersion` 与预览返回的 `basis`。
  版本过期 → **409** 整批拒绝且不写入；预览所依据的行已变化（basis 不符）→ **409**
  `details.code=BATCH_EDIT_STALE`；提交体重跑同一套区间 / 冲突 / 跨文献行校验（400 定位）。
  **成功只推进一次文献版本**，返回 `{ ok, version, result }`（`result` 与预览同构）；
  **已发布快照保持原样**。行不存在 → 404；文献不存在 → 404。

接口：

```bash
# 预览（只读）
curl -X POST http://localhost:4000/api/documents/1/lines/batch-edit/preview \
  -H 'Content-Type: application/json' \
  -d '{
    "edits": [
      { "lineId": 10, "startCp": 0, "endCp": 0, "replacement": "曰" },
      { "lineId": 10, "startCp": 5, "endCp": 6, "replacement": "性" },
      { "lineId": 21, "startCp": 3, "endCp": 4, "replacement": "" }
    ]
  }'

# 确认整批写入（携带预览响应里的 version 与 basis）
curl -X POST http://localhost:4000/api/documents/1/lines/batch-edit \
  -H 'Content-Type: application/json' \
  -d '{
    "expectedVersion": 7,
    "edits": [
      { "lineId": 10, "startCp": 0, "endCp": 0, "replacement": "曰" },
      { "lineId": 10, "startCp": 5, "endCp": 6, "replacement": "性" },
      { "lineId": 21, "startCp": 3, "endCp": 4, "replacement": "" }
    ],
    "basis": [
      { "lineId": 10, "lineNo": 1, "msId": 2, "msName": "乙本", "content": "天命之謂性率性之謂道", "lengthCp": 10 }
    ]
  }'
```

预览返回：`documentId/version/editCount`、`lines[]`（`lineId/lineNo/msId/msName/oldContent/newContent/
oldLengthCp/newLengthCp/edits[]`）、`fragments[]`（`fragmentId/groupId/groupOrd/groupAlreadyBroken/
lineId/lineNo/oldStartCp/oldEndCp` 与 `status/newStartCp/newEndCp/note`）、
`brokenGroups[]`（`groupId/ord/newlyBroken/reason`）、`basis[]`（每个被改行一条）。

### 行界调整（拆分 / 合并原始行，不改变字序）
校勘人员可在**不改变字序**的前提下调整一份抄本的原始行界：按 Unicode 码点在**行内拆分**，
或**合并相邻两行**。一律「先预览、再凭文献版本确认」：

- **预览（只读，不推进版本）**：返回调整后的**行序**（`lines[]`：保留 / 顺移 / 拆分左右段 /
  合并行，含调整前后行号对照）、**片段新位置**（`fragments[]`：`unchanged` 原位保留 /
  `moved` 迁移并重算区间 / `broken` 跨拆分点待修复）、**待修复组**（`brokenGroups[]`，
  区分「新标待修复」与「原已待修复」），以及提交时须原样带回的 `basis` 与当前文献 `version`。
- **拆分**：左段保留原行 id，右段成为新行，后续行号顺移 +1。
  未跨拆分点的片段随文字迁移并重算区间；**跨点片段保留原行原区间**（右端越界，可追溯定位）
  并把所在组标为待修复——其文字只呈现越界前可见部分，**不得把另一行文字当作其确定文字**。
- **合并**：右行片段迁至左行（合并行保留左行 id，内容相接），右行删除，后续行号顺移 -1；
  **原已待修复组不得自动转为完好**；**缺文标记不变**（缺文不依附行，两种操作均不动）。
- **一致性**：调整后原文视图、对应组与发布门禁天然一致（同一套读模型与发布校验）；
  跨点产生待修复组时，修复前不得发布新版；**已发布快照保持原样**。
- **明确拒绝**：非法码点位置（拆分点不在 `1–行字数-1` 内）、非相邻行、同一行与自身合并、
  两行不属于同一抄本、行不属于本文献 → 400；行 / 文献不存在 → 404。
- **提交**：携带 `expectedVersion` 与预览返回的 `basis`。
  版本过期 → 409；预览所依据的行已变化（basis 不符）→ 409 `details.code=RELINE_STALE`；
  二者皆**整次拒绝、不写入、不推进版本**；缺 basis → 400。**成功仅推进一次版本**，
  响应回填拆分新行 id 与各片段落位（`result` 与预览同构）。

接口：

```bash
# 预览拆分（只读）：甲本某行在第 5 个码点处拆开
curl 'http://localhost:4000/api/documents/1/reline/preview?op=split&lineId=10&splitCp=5'
# 预览合并（只读）：相邻两行并为一行
curl 'http://localhost:4000/api/documents/1/reline/preview?op=merge&leftLineId=10&rightLineId=11'

# 提交拆分（携带预览响应里的 version 与 basis）
curl -X POST http://localhost:4000/api/documents/1/reline \
  -H 'Content-Type: application/json' \
  -d '{
    "expectedVersion": 7,
    "op": "split",
    "lineId": 10,
    "splitCp": 5,
    "basis": { "lineId": 10, "lineNo": 1, "content": "天命之謂性率性之謂道", "lengthCp": 10 }
  }'

# 提交合并
curl -X POST http://localhost:4000/api/documents/1/reline \
  -H 'Content-Type: application/json' \
  -d '{
    "expectedVersion": 8,
    "op": "merge",
    "leftLineId": 10,
    "rightLineId": 11,
    "basis": {
      "leftLineId": 10, "leftLineNo": 1, "leftContent": "天命之謂性", "leftLengthCp": 5,
      "rightLineId": 11, "rightLineNo": 2, "rightContent": "率性之謂道", "rightLengthCp": 5
    }
  }'
```

预览返回：`documentId/version/op/msId/msName`（拆分另含 `splitCp`）、`basis`、
`lines[]`（`lineId/lineNo/oldLineNo/content/origin`，拆分新行 `lineId=null`）、
`fragments[]`（`fragmentId/groupId/groupOrd/groupAlreadyBroken`、原位置与新位置、`status/note`）、
`brokenGroups[]`（`groupId/ord/newlyBroken/reason`）。
提交成功返回 `{ ok, version, result }`（`result` 与预览同构，新行 id 已回填）。

### 发布与旧版
- 发布生成 **不可变快照**（JSONB，固化发布定稿时的版本号）。发布后继续修改只影响工作版，
  **旧发布版始终可阅读**（“发布与旧版”页签 → 阅读此版）。
- 在版本对照页查看某已发布版与当前工作版的差异后，可点 **“确认恢复”** 将工作版整体恢复为该版
  （规则见下文“恢复已发布校勘版”）。

### 版本对照（任一已发布校勘版 ↔ 当前工作版）
- 在“发布与旧版”页签对任一已发布版本点 **“与当前工作版对照”**（或在旧版阅读页点同名按钮），
  打开版本对照页；**页面与 HTTP API 返回同一结果**，均为只读：不修改工作版，也不修改快照，
  点“刷新”即按当前最新工作版重新对照。
- **行文增删改**：按“抄本 + 该抄本原始行号”列出新增行 / 删除行 / 行内改字，行内以码点级
  增删标记呈现（生僻字按 Unicode 码点处理）。
- **对应组**：呈现组序变化、各抄本片段（位置/文字）与缺文标记的变化。
  整批重存会更换全部组 ID，因此对照 **绝不凭组 ID / 组序判定增删**：
  仅在两侧底本相同、且某组底本片段的“原始行号 + 码点区间”在两侧各自唯一并一一对应时才配对；
  无法唯一配对的旧组、新组分别列入“未配对”，**不推断移动**；
  两侧底本不同则完全不配对，旧组与新组分别列出（原因显式标注）。
- **待修复组显式标识**：待修复 / 越界片段的文字 **不作为确定文字**（标注为待修复，
  越界前可见部分仅作参考），两侧均完好时才给出“文字已变”的确定结论。
- 对照页头部同时显示两侧 **底本与版本号**（旧版：第 N 版及快照版本号；新版：当前工作版版本号）。
- 旧版不存在时接口与页面均明确报错（404，提示当前已发布至第几版）。
- 接口：`GET /api/documents/:id/editions/:no/diff`，例如

  ```bash
  curl http://localhost:4000/api/documents/1/editions/1/diff
  ```

  返回：`sides`（两侧底本/版本号/组数/待修复数）、`textChanges`（行文增删改）、
  `groupDiff.paired`（配对组的组序与各抄本片段、缺文变化）、
  `groupDiff.unpairedOld / unpairedNew`（未配对旧/新组及原因）。

### 恢复已发布校勘版（以旧版整体重建当前工作版）
整理者在“发布与旧版”中选取一个**已发布校勘版**，点“与当前工作版对照”查看差异后，
在版本对照页点 **“确认恢复”**（也可直接调 HTTP API）：

- **恢复范围**：该版快照中的**抄本及顺序、底本、全部原始行、对应组片段与缺文标记**，
  被整体重建为该版定稿状态——发布后新增的抄本/行/组被移除，删除/改动的内容复原，
  整批重存后的组按快照重放。**文献标题、已发布版编号（`published_ver`）和全部快照
  （含目标版自身）保持原样**，旧版仍可阅读、对照。
- **有效标识**：重建后的**行与组取得当前有效标识**（全新 id；不沿用快照中的旧行/旧组 id）；
  抄本沿用其跨版本的稳定身份 id（快照中缺失的抄本按原 id 补回，序列自动推进）。
  因此恢复后现有的行内改字、行界调整、整批归组、单组修复、删除、补配、对照、发布流程
  **全部仍可正常使用**。
- **乐观锁**：提交必须携带**对照时看到的当前工作版版本号** `expectedVersion`。
  - 版本已变化（`expectedVersion` ≠ 当前版本）→ **409**，拒绝且**不改动任何数据**；
  - 目标版不存在 → **404**（提示当前已发布至第几版），拒绝且不改动数据；版号非法 → 400；
  - **快照内容无法构成合法归组**（快照结构损坏、底本/行缺失、片段越界、行内重叠、
    片段文字与原文区间不符、组序不连续等）→ **409**，
    `details.code=RESTORE_SNAPSHOT_INVALID`、`details.issues[]` 逐条给出 `code` 与位置
    （组序 / 抄本名 / 行号 / 区间），**整体拒绝且不改动数据、不推进版本**。
    （正常发布产生的快照必为合法归组；该校验用于抵御任何半损坏 / 被篡改的快照。）
- **成功后工作版版本号只前进一次**，返回 `{ ok, editionNo, version, restored }`，
  `restored` 给出重建的抄本/行/组/片段/缺文计数与底本 id。恢复后再做版本对照，
  该版与当前工作版应完全一致（无行文变化、配对组全部 `same`）。

接口：

```bash
# expectedVersion 取对照（GET .../diff）时返回的 sides.new.version
curl -X POST http://localhost:4000/api/documents/1/editions/1/restore \
  -H 'Content-Type: application/json' \
  -d '{ "expectedVersion": 12 }'
```

成功返回：

```json
{
  "ok": true,
  "editionNo": 1,
  "version": 13,
  "restored": {
    "manuscriptCount": 3, "lineCount": 6, "groupCount": 4,
    "fragmentCount": 10, "missingCount": 2, "baseMsId": 7
  }
}
```

### 文献归档（导出 / 导入为另一篇文献）
整理者可在工作区「归档」页签（也可直接调 HTTP API）把一篇文献**下载为可迁移归档**，
并把该归档**导入为另一篇独立文献**（跨环境迁移 / 备份 / 复制工作底本）。

- **导出（只读，不推进版本）**：在单个 SERIALIZABLE 事务内读取文献全部状态，
  归档对应**同一已提交版本**（`document.version` 即该工作版版本号）；未改动时重复导出内容逐字节一致。
  归档为单个 JSON 文件，带格式标识与格式版本（`format="collation-archive"`、`formatVersion=1`），内含：
  - 标题、工作版版本号、已发布版序号、**底本**引用；
  - **抄本及顺序**、全部**原始行**（含行序与文字）；
  - **当前对应组**（组序、**待修复状态**、各抄本片段坐标与**缺文标记**；
    待修复组的越界坐标原样保留）；
  - **全部已发布版快照**（编号、发布时间、快照本体）。
  归档内的 id 均为「归档局部引用」（导出时取源库 id），导入时全部重建，与任何现存文献互不干扰。
- **导入（单次事务，先校验后写入，任一处不合法即整次回滚、不创建任何文献）**：
  - **未知格式 / 格式版本不符** → 400 拒绝；
  - **当前完好组**按**现行归组规则**全量校验（与整批保存同一套：底本唯一、
    每抄本每组至多一片、不行内重叠、不越界、组序自 1 连续）；
  - **待修复组**可保留原有**越界坐标**，但其真实片段不得有**负值、逆序、零长度或悬空引用**
    （引用不存在的抄本 / 行，或引用他抄本的行）；
  - **每个已发布版快照均须能构成合法归组**（与「恢复已发布校勘版」同一套快照校验）；
  - 发布版编号须自 1 连续且与 `publishedVer` 一致；
  - 全部问题以 `details.code=ARCHIVE_INVALID`、`details.issues[]` **逐条给出位置与原因**
    （section / 发布版号 / 组序 / 抄本名 / 行号），整次拒绝。
- **重建内部标识及关联**：新文献的文献 / 抄本 / 行 / 组 / 片段全部取得新 id；
  快照内的抄本引用同步重建为新标识（历史快照独有、工作版已删除的抄本为其保留全新空闲标识，
  恢复该版时可物化而不与任何文献冲突）。工作版版本号与已发布版序号按归档落库。
- **导入成功不改动源文献**；新文献的旧版仍可**阅读、对照、恢复**，工作版仍可编辑、
  修复、行界调整、补配并按现有门禁**继续编号发布**；**同一文件重复导入各自创建独立文献**。
- 工作区「归档」页签展示导入结果（新文献编号与各项计数，可一键打开新文献）及逐条错误原因。

接口：

```bash
# 导出（响应即归档 JSON，带 Content-Disposition 便于直接下载）
curl -OJ http://localhost:4000/api/documents/1/archive

# 导入（请求体即归档文件内容）
curl -X POST http://localhost:4000/api/documents/import \
  -H 'Content-Type: application/json' \
  --data-binary @中庸·首章-v12.collation.json
```

导入成功返回 `201`：

```json
{
  "ok": true,
  "documentId": 5,
  "title": "中庸·首章",
  "version": 12,
  "publishedVer": 2,
  "imported": {
    "manuscriptCount": 3, "lineCount": 6, "groupCount": 4,
    "brokenGroupCount": 1, "fragmentCount": 10, "missingCount": 2,
    "editionCount": 2
  }
}
```

校验失败返回 `400`（无任何写入）：

```json
{
  "error": "归档校验失败：共 1 处问题，已整次拒绝、未导入任何内容",
  "details": {
    "code": "ARCHIVE_INVALID",
    "issues": [
      { "code": "OUT_OF_RANGE", "section": "groups", "groupOrd": 1, "msName": "乙本", "lineNo": 1,
        "message": "完好组非法：第 1 组「乙本」越界：该行共 10 字，片段位于第 1 行第 6–99 字；合法范围为第 1–10 字" }
    ]
  }
}
```


### 并发控制
- 所有写请求必须携带 `expectedVersion`（乐观锁）；
- 基于过期版本的修改返回 **409 拒绝**，不做任何写入，前端提示刷新后重试；
- 事务隔离级别为 `SERIALIZABLE`，序列化冲突同样返回 409。

---

## 四、HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/documents` | 文献列表 |
| POST | `/api/documents` | 新建（标题 + ≥2 份抄本名） |
| GET | `/api/documents/:id` | 校勘读模型（组/异文/缺文/倒置/原始行/覆盖区间/版本号） |
| POST | `/api/documents/:id/manuscripts` | 增加抄本 |
| PUT | `/api/documents/:id/base` | 选定底本 |
| POST | `/api/manuscripts/:msId/lines` | 追加一行 |
| PUT | `/api/lines/:lineId` | 行内改字（`startCp/endCp/replacement`） |
| POST | `/api/documents/:id/lines/batch-edit/preview` | **批量行改预览**（只读）：多抄本多行多处编辑，返回各行新文字/片段新位置/受影响组 |
| POST | `/api/documents/:id/lines/batch-edit` | **确认批量行改**（携带 `basis`；区间重叠/同点插入/插入点落他区间含端点/跨文献行 400 定位；过期 409、basis 不符 409 `BATCH_EDIT_STALE`，成功只推进一次） |
| PUT | `/api/documents/:id/groups` | 整批保存对应组（替换式，全量校验） |
| PUT | `/api/documents/:id/groups/:gid/repair` | 修复单个对应组 |
| DELETE | `/api/documents/:id/groups/:gid` | 删除对应组 |
| GET | `/api/documents/:id/supplement/preview?targetMsId=` | **补配预览**（只读）：目标抄本空闲区间内的同文候选 |
| POST | `/api/documents/:id/supplement` | **提交补配**（整批重核；过期 409 / 候选失效 409 不推进） |
| GET | `/api/documents/:id/reline/preview?op=…` | **行界调整预览**（只读）：拆分 `op=split&lineId=&splitCp=`；合并 `op=merge&leftLineId=&rightLineId=` |
| POST | `/api/documents/:id/reline` | **提交行界调整**（携带 `basis`；过期 409 / 行已变化 409 不推进，成功只推进一次） |
| POST | `/api/documents/:id/publish` | 发布新版（有待修复组则 409） |
| GET | `/api/documents/:id/editions` / `…/editions/:no` | 版本列表 / 阅读旧版快照 |
| GET | `/api/documents/:id/editions/:no/diff` | **该已发布版与当前工作版的版本对照**（旧版不存在 → 404） |
| POST | `/api/documents/:id/editions/:no/restore` | **确认恢复为该已发布版**（整体重建抄本/底本/行/组片段/缺文；版本过期 409、版不存在 404、快照不合法 409 `RESTORE_SNAPSHOT_INVALID`，皆不改动数据；成功只推进一次版本） |
| GET | `/api/documents/:id/archive` | **导出可迁移归档**（只读，同一已提交版本；含标题/抄本及行序/底本/当前组片段/缺文与待修复/工作版版本号/全部已发布版快照，带格式版本） |
| POST | `/api/documents/import` | **导入归档为另一篇文献**（单次事务校验并重建全部内部标识；未知格式/缺失引用/损坏快照/完好组非法区间 → 400 `ARCHIVE_INVALID` 逐条定位、整次拒绝；源文献不受影响，重复导入各自独立） |

写请求体均含 `expectedVersion`；错误响应：`{ "error": "...", "details": [ { "code", "message", "groupOrd", "msName", "lineNo", ... } ] }`。

---

## 五、测试

后端使用内嵌 PostgreSQL（PGlite，WASM）做端到端集成测试，无需外部数据库：

```bash
cd server
npm test
```

覆盖：合法归组、异文/缺文判定、倒置、越界/重叠/缺底本/重复抄本报错定位、
整体拒绝不部分保存、乐观锁 409、改字仅波及相关组、平移、缩短越界、
修复流程、发布门禁、旧版快照可读、切换底本，以及
**版本对照：行文增删改（按原始行号）、整批重存换组 ID 仍按底本位置唯一配对、
无法配对组分别列出且不推断移动、底本不同不配对、缺文标记变化、待修复组显式标识且越界文字不作确定文字、
旧版不存在 404、对照只读且刷新反映最新工作版，以及
**补配：仅纳入无片段且未缺文的完好组（待修复/已有片段/已缺文排除）、单行完整同文且按码点定位、
避开全部现存片段区间、unique/multiple/conflict/none 状态与原因、组间候选区间重叠标注、
唯一无冲突可采纳、多候选与冲突须人选取舍、提交在当前版重核组/文字/空闲区间/归组规则且整批通过才写入、
未选组与已有片段保留、预览只读不推进、过期版本 409、候选失效（已占/文字已变/越界/行易主/已有片段/候选互相重叠）
整批拒绝且不推进、成功只推进一次版本、扩展 B 区生僻字按码点计、请求体非法 400、文献不存在 404**，以及
**行界调整：拆分预览行序/片段新位置/待修复组、端点相接不跨点、未跨点片段迁移重算区间、
跨点片段保留原行原区间可追溯且所在组待修复（越界文字不作确定文字、原文覆盖区间截断标识一致）、
缺文标记不变、合并右行片段迁至左行且原待修复组不自动转完好、行号顺移、发布后快照保持原样、
发布门禁与待修复一致（待修复 409、修复后放行）、非法码点位置/非相邻行/自身合并/跨抄本/他文献行 400、
行或文献不存在 404、扩展 B 区生僻字按码点拆分、预览只读不推进、缺 basis 400、
过期版本 409 与 basis 不符 409（RELINE_STALE）皆整次拒绝不推进、成功只推进一次版本**，以及
**恢复已发布校勘版：抄本及顺序/底本/全部原始行/组片段与缺文整体重建、后增抄本移除、
标题与已发布版编号及全部快照不变、重建行与组取得新 id 而抄本沿用稳定身份、
恢复后与该版对照完全一致、恢复后改字/修复/行界/补配/对照/再发布/新增抄本全流程可用、
成功版本号只前进一次、缺 expectedVersion 400、版本已变化 409 不改动、目标版不存在 404、
损坏快照（片段越界）409 RESTORE_SNAPSHOT_INVALID 逐条说明且整体拒绝不推进版本**，以及
**批量行改：同一行多个不相交编辑按原坐标同时生效、跨抄本累计位移、端点相接只平移不待修复、
插入点严格位于片段内部才待修复（边界只平移）、相交/缩行越界保留可追溯坐标并标组待修复、
原已待修复组与缺文不自动改好、预览只读不推进、区间重叠/同点重复插入/插入点落他区间内部及端点/
非法区间/跨文献行整批报错定位（BAD_RANGE/OVERLAPPING_RANGES/DUPLICATE_INSERTION/
INSERTION_POINT_IN_INTERVAL/LINE_NOT_IN_DOC/BAD_SHAPE）、非零长编辑端点相接允许、
行或文献不存在 404、缺 basis 400、过期版本 409 与 basis 不符 409（BATCH_EDIT_STALE）皆整批拒绝不写入不推进、
成功只推进一次版本、已发布快照保持原样、扩展 B 区生僻字按码点替换**，以及
**文献归档：导出含格式版本/标题/抄本及行序/底本/当前组片段/缺文与待修复/工作版版本号/全部已发布版快照、
导出只读不推进版本、未改动重复导出内容一致、导入重建全部内部标识（抄本/行/组/快照引用）、
待修复组越界坐标与缺文状态保留、导入文献旧版可阅读/对照/恢复、可继续编辑与按门禁编号发布、
多发布版归档逐版可恢复、历史快照独有抄本以新标识物化、同一文件重复导入各自独立、
导入不改动源文献、空组列表与缺底本待修复组可导入、
未知格式/格式版本/非对象/元信息缺失/底本引用缺失/抄本重名/顺序不连续/行引用缺失/行号不连续/
片段悬空引用（抄本/行/他抄本的行）/待修复组负值/逆序/零长度/完好组越界/重叠/缺底本/
空组/组序重复缺号/发布版编号缺号/publishedVer 不符/快照损坏逐条定位（ARCHIVE_INVALID）并整次拒绝不创建文献**。

---

## 六、目录结构

```
.
├── Dockerfile                # 多阶段构建：前端 → 后端 → 静态托管
├── docker-compose.yml        # 一键：db(PostgreSQL 16) + app
├── db/schema.sql             # 数据库结构（幂等，可重复执行）
├── server/                   # Node.js + TypeScript + Express
│   └── src/ (db/validate/collation/diff/supplement/reline/restore/archive/routes/repo/...)
└── web/                      # React 18 + Vite + TypeScript
    └── src/ (录文 / 归组 / 对照 / 发布与旧版 / 版本对照 / 归档)
```
