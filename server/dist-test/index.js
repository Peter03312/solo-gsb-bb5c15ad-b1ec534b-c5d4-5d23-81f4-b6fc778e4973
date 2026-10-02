"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = require("./app");
const db_1 = require("./db");
const port = Number(process.env.PORT || 4000);
(async () => {
    await (0, db_1.waitForDb)();
    await (0, db_1.initSchema)();
    (0, app_1.createApp)().listen(port, '0.0.0.0', () => {
        console.log(`校勘应用后端已启动: http://localhost:${port}`);
    });
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
