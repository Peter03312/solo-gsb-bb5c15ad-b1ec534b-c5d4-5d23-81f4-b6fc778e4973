import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { router } from './routes';
import { HttpError } from './util';

export function createApp() {
  const app = express();
  // 归档导入的体积上限放宽（归档含全部已发布版快照，远大于普通写请求）
  app.use(express.json({ limit: '16mb' }));

  app.use('/api', router);
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // 生产环境：托管前端构建产物（SPA）
  const publicDir = path.join(__dirname, '..', 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, details: err.details });
      return;
    }
    const code = (err as { code?: string })?.code;
    if (code === '40001' || code === '23505') {
      res.status(409).json({ error: '并发冲突或数据已变化，请刷新后重试' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: '服务器内部错误' });
  });

  return app;
}
