# 快速开始（本地开发）

本文档说明如何在本地搭建并启动 Duelyst 开发环境。

## 1. 环境准备

- **Node.js**：v24（启用 Corepack 与 Yarn 4，见根目录 `package.json` 的 `packageManager`）
- **Docker & Docker Compose**：用于运行 Postgres、Redis 及后端服务容器
- **Google Firebase**：免费账号即可，用于 Realtime Database（支持 `asia-southeast1` 等区域实例）

安装依赖：

```bash
corepack enable
corepack yarn workspaces focus
corepack yarn tsc:chroma-js
```

## 2. 配置 Firebase

1. 在 Firebase 控制台创建项目并启用 **Realtime Database**（支持区域 URL，如 `https://<db>-default-rtdb.asia-southeast1.firebasedatabase.app/`）。
2. 将仓库根目录的 [firebaseRules.json](../firebaseRules.json) 发布为数据库的 Security Rules。
3. 在项目设置中获取：
   - Web App 的 `apiKey`（Project Settings → General → Your apps）
   - 服务账号密钥 JSON（Project Settings → Service Accounts → Generate new private key），保存为根目录 `serviceAccountKey.json`
4. 在根目录创建 `.env`（已被 `.gitignore` 忽略，切勿提交）：

```bash
FIREBASE_URL=https://<your-db>-default-rtdb.asia-southeast1.firebasedatabase.app/
FIREBASE_API_KEY=<YOUR_FIREBASE_WEB_API_KEY>
FIREBASE_REGION=asia-southeast1
FIREBASE_PROJECT_ID=<YOUR_PROJECT_ID>
FIREBASE_CLIENT_EMAIL=<YOUR_CLIENT_EMAIL>
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

> 如需在主菜单开启商店，可在 Firebase RTDB 中将 `/system-status/shop_enabled` 设为 `true`。

## 3. 构建前端

```bash
corepack yarn build
```

> **注意**：`gulp` 在构建期会通过 `envify` 将 `API_URL`、`FIREBASE_URL`、`FIREBASE_API_KEY`、`NODE_ENV` 等静态写入 `dist/src`；修改这些环境变量后必须重新构建。

## 4. 启动本地服务

首次启动或有新迁移时，先初始化 Postgres 数据库：

```bash
docker compose up migrate
```

启动全部本地服务（`api`、`sp`、`game`、`worker`、`db`、`redis`）：

```bash
docker compose up
```

看到 `Duelyst 'development' started on port 3000` 后，在浏览器打开 `http://localhost:3000/` 即可注册账号并进入游戏（默认简体中文）。

## 5. 常见排错入口

- **浏览器控制台**：重点排查 `warning` / `error`，尤其是 Firebase 鉴权与 Socket.IO（`ws://localhost:8000` / `8001`）连接状态。
- **Docker 日志**：查看 `docker compose logs -f api sp game worker` 中的报错堆栈。
