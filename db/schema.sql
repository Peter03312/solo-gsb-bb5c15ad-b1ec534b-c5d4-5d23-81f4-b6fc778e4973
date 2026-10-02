-- 多抄本校勘应用 数据库结构
-- 应用启动时会自动执行本文件；亦可手动 psql -f db/schema.sql

CREATE TABLE IF NOT EXISTS documents (
    id             BIGSERIAL PRIMARY KEY,
    title          TEXT NOT NULL,
    base_ms_id     BIGINT,
    version        BIGINT NOT NULL DEFAULT 1,   -- 乐观锁版本号
    published_ver  INTEGER NOT NULL DEFAULT 0,  -- 已发布校勘版序号（0=从未发布）
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS manuscripts (
    id       BIGSERIAL PRIMARY KEY,
    doc_id   BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    name     TEXT NOT NULL,
    position INTEGER NOT NULL,          -- 抄本在文献内的展示次序
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (doc_id, position)
);

-- 幂等：约束/索引的存在性判断（CREATE TABLE 已全部 IF NOT EXISTS）
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_base_fk') THEN
        ALTER TABLE documents
            ADD CONSTRAINT documents_base_fk
            FOREIGN KEY (base_ms_id) REFERENCES manuscripts(id) ON DELETE SET NULL;
    END IF;
END $$;

-- 逐行文字；line_no 为该抄本内的原始行序
CREATE TABLE IF NOT EXISTS lines (
    id       BIGSERIAL PRIMARY KEY,
    ms_id    BIGINT NOT NULL REFERENCES manuscripts(id) ON DELETE CASCADE,
    line_no  INTEGER NOT NULL,
    content  TEXT NOT NULL DEFAULT '',
    UNIQUE (ms_id, line_no)
);

-- 对应组（使用 grp 避免与 SQL 保留字 GROUP 冲突）
CREATE TABLE IF NOT EXISTS grp (
    id          BIGSERIAL PRIMARY KEY,
    doc_id      BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ord         INTEGER NOT NULL,       -- 底本顺序（组序号）
    broken      BOOLEAN NOT NULL DEFAULT FALSE,  -- TRUE=待修复
    UNIQUE (doc_id, ord)
);

-- 片段：每 组×抄本 至多一条；missing=TRUE 表示该抄本此处显式缺文
CREATE TABLE IF NOT EXISTS fragments (
    id       BIGSERIAL PRIMARY KEY,
    group_id BIGINT NOT NULL REFERENCES grp(id) ON DELETE CASCADE,
    doc_id   BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ms_id    BIGINT NOT NULL REFERENCES manuscripts(id) ON DELETE CASCADE,
    line_id  BIGINT REFERENCES lines(id) ON DELETE CASCADE,
    start_cp INTEGER,                   -- Unicode 码点偏移（左闭，缺文时为空）
    end_cp   INTEGER,                   -- Unicode 码点偏移（右开，缺文时为空）
    missing  BOOLEAN NOT NULL DEFAULT FALSE
);

-- 同一 组×抄本 至多一条（含缺文标记）
CREATE UNIQUE INDEX IF NOT EXISTS uq_fragments_group_ms
    ON fragments(group_id, ms_id);
-- 同一抄本同一条行上允许存在多个片段，但区间不得重叠：
-- 一行可有多个互不重叠的片段，故不能在此加唯一约束；
-- “不得重叠归组 / 越界 / 缺底本” 的完整定位式校验见 src/validate.ts，
-- 校验在同一事务内完成，任一错误即整体回滚，绝不部分保存。

-- 已发布校勘版快照（不可变）
CREATE TABLE IF NOT EXISTS editions (
    id         BIGSERIAL PRIMARY KEY,
    doc_id     BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    edition_no INTEGER NOT NULL,
    snapshot   JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (doc_id, edition_no)
);

-- 整理者对「工作版对应组」的判读意见（每组至多一条；group_id 为空=对应组消失 / 无法唯一对应后的待复核孤儿）
CREATE TABLE IF NOT EXISTS group_judgments (
    id              BIGSERIAL PRIMARY KEY,
    doc_id          BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    group_id        BIGINT REFERENCES grp(id) ON DELETE SET NULL,
    chosen_ms_id    BIGINT REFERENCES manuscripts(id) ON DELETE SET NULL,  -- 已裁定：所选抄本；未裁定为空
    chosen_line_id  BIGINT REFERENCES lines(id) ON DELETE CASCADE,        -- 所选有效片段所在行（未裁定为空）
    decided         BOOLEAN NOT NULL,                 -- TRUE=已裁定（选定一份抄本）；FALSE=明确标为未裁定
    reason          TEXT NOT NULL DEFAULT '',         -- 理由（已裁定必填，未裁定可空）
    quote_text      TEXT NOT NULL DEFAULT '',         -- 已裁定：引用文字（裁定当时的片段文字）
    -- 组锚点（底本片段身份）：底本抄本 + 该抄本原始行号 + 码点左闭右开 + 底本片段文字
    base_ms_id      BIGINT,
    base_line_no    INTEGER,
    base_start_cp   INTEGER,
    base_end_cp     INTEGER,
    base_text       TEXT NOT NULL DEFAULT '',
    -- 已裁定的所选片段锚点：原始行号 + 码点区间（随行文平移，对账时刷新；行界变化后仅可追溯）
    chosen_line_no  INTEGER,
    chosen_start_cp INTEGER,
    chosen_end_cp   INTEGER,
    needs_review    BOOLEAN NOT NULL DEFAULT FALSE,   -- 待复核闩锁：一旦置 TRUE，只能由人重新确认 / 撤回清除
    review_reason   TEXT NOT NULL DEFAULT '',         -- 待复核原因（中文，可定位）
    frozen          BOOLEAN NOT NULL DEFAULT FALSE,   -- TRUE=由恢复已发布版带回的固化意见
    last_ord        INTEGER,                          -- 最近一次挂载的组序号（孤儿意见的追溯信息）
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 每个对应组至多一条意见（孤儿意见 group_id 为空，不受此约束限制）
CREATE UNIQUE INDEX IF NOT EXISTS uq_judgment_group
    ON group_judgments(group_id) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_judgments_doc ON group_judgments(doc_id);

CREATE INDEX IF NOT EXISTS idx_manuscripts_doc ON manuscripts(doc_id);
CREATE INDEX IF NOT EXISTS idx_lines_ms ON lines(ms_id);
CREATE INDEX IF NOT EXISTS idx_grp_doc ON grp(doc_id);
CREATE INDEX IF NOT EXISTS idx_fragments_group ON fragments(group_id);
CREATE INDEX IF NOT EXISTS idx_fragments_doc ON fragments(doc_id);
CREATE INDEX IF NOT EXISTS idx_editions_doc ON editions(doc_id);
