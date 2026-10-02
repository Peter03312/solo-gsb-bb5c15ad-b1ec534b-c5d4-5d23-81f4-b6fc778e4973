# ---- 前端构建 ----
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- 后端构建 ----
FROM node:20-alpine AS server
WORKDIR /app
# 构建需要 typescript（devDependencies），先全量安装、构建后再裁剪为生产依赖
COPY server/package.json server/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src ./src
COPY db /db
RUN npm run build && npm prune --omit=dev && npm cache clean --force

# 前端静态产物交由后端 Express 托管
COPY --from=web /web/dist /app/public

ENV NODE_ENV=production \
    PORT=4000 \
    PGHOST=db \
    PGPORT=5432 \
    PGUSER=collation \
    PGPASSWORD=collation \
    PGDATABASE=collation \
    SCHEMA_FILE=/db/schema.sql
EXPOSE 4000
CMD ["node", "dist/index.js"]
