import pg, { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

// BIGSERIAL (oid 20) 统一以 number 返回，简化 TS 处理
pg.types.setTypeParser(20, (v: string) => Number(v));

export interface DataPool {
  query: <T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) => Promise<QueryResult<T>>;
  connect: () => Promise<PoolClient>;
  execScript?: (sql: string) => Promise<void>;
}

function createPgPool(): DataPool {
  return new Pool({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'collation',
    password: process.env.PGPASSWORD || 'collation',
    database: process.env.PGDATABASE || 'collation',
    max: 10,
  }) as unknown as DataPool;
}

/** 测试环境用 PGlite（WASM PostgreSQL）注入，接口与 node-postgres 对齐。 */
function createPgLitePool(): DataPool {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PGlite } = require('@electric-sql/pglite');
  const instance = new PGlite();
  const run = async (text: string, params?: unknown[]) => {
    const res = await instance.query(text, params as unknown[]);
    // int8 在 PGlite 中以字符串返回，按字段 oid 转回 number
    if (Array.isArray(res.rows) && Array.isArray(res.fields)) {
      for (const row of res.rows as Record<string, unknown>[]) {
        for (const f of res.fields as Array<{ name: string; dataTypeID: number }>) {
          if (f.dataTypeID === 20 && typeof row[f.name] === 'string') {
            row[f.name] = Number(row[f.name]);
          }
        }
      }
    }
    return res;
  };
  const client = {
    query: (text: string, params?: unknown[]) => run(text, params),
    release: () => undefined,
  } as unknown as PoolClient;
  return {
    query: (text: string, params: unknown[] = []) => run(text, params),
    connect: async () => client,
    execScript: async (sql: string) => {
      await instance.exec(sql);
    },
  };
}

const pool: DataPool =
  process.env.DATABASE_DRIVER === 'pglite' ? createPgLitePool() : createPgPool();

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

/** 在 SERIALIZABLE 事务中执行；fn 抛出则整体回滚（绝不部分保存）。 */
export async function withTx<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function waitForDb(retries = 60, delayMs = 1000): Promise<void> {
  if (process.env.DATABASE_DRIVER === 'pglite') return; // 内嵌库无需等待
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('无法连接 PostgreSQL');
}

export async function initSchema(): Promise<void> {
  const sqlFile =
    process.env.SCHEMA_FILE || path.join(__dirname, '..', '..', 'db', 'schema.sql');
  const sql = fs.readFileSync(sqlFile, 'utf8');
  if (pool.execScript) {
    await pool.execScript(sql); // PGlite：多语句走 exec
  } else {
    await pool.query(sql);
  }
}
