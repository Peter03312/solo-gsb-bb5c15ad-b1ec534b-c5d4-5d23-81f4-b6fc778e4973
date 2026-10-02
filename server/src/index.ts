import { createApp } from './app';
import { initSchema, waitForDb } from './db';

const port = Number(process.env.PORT || 4000);

(async () => {
  await waitForDb();
  await initSchema();
  createApp().listen(port, '0.0.0.0', () => {
    console.log(`校勘应用后端已启动: http://localhost:${port}`);
  });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
