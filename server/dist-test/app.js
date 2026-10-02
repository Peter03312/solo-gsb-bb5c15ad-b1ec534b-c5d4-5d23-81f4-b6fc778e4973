"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const routes_1 = require("./routes");
const util_1 = require("./util");
function createApp() {
    const app = (0, express_1.default)();
    // 归档导入的体积上限放宽（归档含全部已发布版快照，远大于普通写请求）
    app.use(express_1.default.json({ limit: '16mb' }));
    app.use('/api', routes_1.router);
    app.get('/api/health', (_req, res) => res.json({ ok: true }));
    // 生产环境：托管前端构建产物（SPA）
    const publicDir = path_1.default.join(__dirname, '..', 'public');
    if (fs_1.default.existsSync(publicDir)) {
        app.use(express_1.default.static(publicDir));
        app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path_1.default.join(publicDir, 'index.html')));
    }
    app.use((err, _req, res, _next) => {
        if (err instanceof util_1.HttpError) {
            res.status(err.status).json({ error: err.message, details: err.details });
            return;
        }
        const code = err?.code;
        if (code === '40001' || code === '23505') {
            res.status(409).json({ error: '并发冲突或数据已变化，请刷新后重试' });
            return;
        }
        console.error(err);
        res.status(500).json({ error: '服务器内部错误' });
    });
    return app;
}
