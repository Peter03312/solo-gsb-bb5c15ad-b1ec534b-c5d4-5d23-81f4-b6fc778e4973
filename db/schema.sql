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

CREATE INDEX IF NOT EXISTS idx_manuscripts_doc ON manuscripts(doc_id);
CREATE INDEX IF NOT EXISTS idx_lines_ms ON lines(ms_id);
CREATE INDEX IF NOT EXISTS idx_grp_doc ON grp(doc_id);
CREATE INDEX IF NOT EXISTS idx_fragments_group ON fragments(group_id);
CREATE INDEX IF NOT EXISTS idx_fragments_doc ON fragments(doc_id);
CREATE INDEX IF NOT EXISTS idx_editions_doc ON editions(doc_id);
