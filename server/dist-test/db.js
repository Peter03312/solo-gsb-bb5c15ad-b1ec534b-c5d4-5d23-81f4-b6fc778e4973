"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.query = query;
exports.withTx = withTx;
exports.waitForDb = waitForDb;
exports.initSchema = initSchema;
const pg_1 = __importStar(require("pg"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// BIGSERIAL (oid 20) 统一以 number 返回，简化 TS 处理
pg_1.default.types.setTypeParser(20, (v) => Number(v));
function createPgPool() {
    return new pg_1.Pool({
        host: process.env.PGHOST || 'localhost',
        port: Number(process.env.PGPORT || 5432),
        user: process.env.PGUSER || 'collation',
        password: process.env.PGPASSWORD || 'collation',
        database: process.env.PGDATABASE || 'collation',
        max: 10,
    });
}
/** 测试环境用 PGlite（WASM PostgreSQL）注入，接口与 node-postgres 对齐。 */
function createPgLitePool() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PGlite } = require('@electric-sql/pglite');
    const instance = new PGlite();
    const run = async (text, params) => {
        const res = await instance.query(text, params);
        // int8 在 PGlite 中以字符串返回，按字段 oid 转回 number
        if (Array.isArray(res.rows) && Array.isArray(res.fields)) {
            for (const row of res.rows) {
                for (const f of res.fields) {
                    if (f.dataTypeID === 20 && typeof row[f.name] === 'string') {
                        row[f.name] = Number(row[f.name]);
                    }
                }
            }
        }
        return res;
    };
    const client = {
        query: (text, params) => run(text, params),
        release: () => undefined,
    };
    return {
        query: (text, params = []) => run(text, params),
        connect: async () => client,
        execScript: async (sql) => {
            await instance.exec(sql);
        },
    };
}
const pool = process.env.DATABASE_DRIVER === 'pglite' ? createPgLitePool() : createPgPool();
async function query(text, params = []) {
    return pool.query(text, params);
}
/** 在 SERIALIZABLE 事务中执行；fn 抛出则整体回滚（绝不部分保存）。 */
async function withTx(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    }
    catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
    }
    finally {
        client.release();
    }
}
async function waitForDb(retries = 60, delayMs = 1000) {
    if (process.env.DATABASE_DRIVER === 'pglite')
        return; // 内嵌库无需等待
    for (let i = 0; i < retries; i++) {
        try {
            await pool.query('SELECT 1');
            return;
        }
        catch {
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
    throw new Error('无法连接 PostgreSQL');
}
async function initSchema() {
    const sqlFile = process.env.SCHEMA_FILE || path.join(__dirname, '..', '..', 'db', 'schema.sql');
    const sql = fs.readFileSync(sqlFile, 'utf8');
    if (pool.execScript) {
        await pool.execScript(sql); // PGlite：多语句走 exec
    }
    else {
        await pool.query(sql);
    }
}
