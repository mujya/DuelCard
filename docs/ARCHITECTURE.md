# 系统架构说明

<img src="diagrams/services.png" alt="服务架构图" width="600" />

## 1. 客户端架构

- 目录：`app/`，公共配置位于 `app/common/config.js`。
- 技术栈：**Backbone.js + Marionette.js**（UI 与状态管理）+ **Cocos2d-JS 3.3**（WebGL/Canvas 游戏渲染）。
- 核心逻辑：`app/sdk/` 为卡牌、技能与回合规则引擎，由客户端与后端共享。
- 本地化：`app/localization/locales/`，默认语言为简体中文（`zh-CN`），支持在设置中切换英文/简中/繁中。
- Firebase 兼容层：`app/common/firebase_compat.js` 在 `firebase@8` 之上封装旧版 v2 风格 `new Firebase()` 接口，用于兼容区域性 RTDB（`*.firebasedatabase.app`）。

## 2. 后端服务架构

后端由 4 个 Node.js 服务组成（主体为 CoffeeScript，配置目录为 `config/`）：

| 服务 | 入口 | 默认端口 | 职责说明 |
|---|---|---|---|
| **API Server** | `bin/api` → `server/api.coffee` | `3000` | Express HTTP API、账号登录/注册、托管前端静态资源（`dist/src`） |
| **Single Player (SP)** | `bin/single_player` → `server/single_player.coffee` | `8000` | Socket.IO 服务，处理单人/AI 对战并将任务推入 Redis 队列 |
| **Game Server** | `bin/game` → `server/game.coffee` | `8001` | Socket.IO 服务，处理多人对战并将任务推入 Redis 队列 |
| **Worker** | `bin/worker` → `worker/worker.coffee` | — | 基于 Kue 轮询 Redis 队列，处理建局、匹配、战绩结算等异步任务（可选 `worker-ui` 在 `:4000` 查看队列） |

## 3. 外部依赖

- **Firebase Realtime Database**：客户端与服务端之间的实时数据通道（对局步骤、在线状态等），服务端封装位于 `server/lib/duelyst_firebase_module.coffee`。
- **PostgreSQL**：持久化用户、卡组、历史对局与迁移记录（`server/lib/data_access/knex.coffee`、`server/migrations/`）。
- **Redis**：Kue 任务队列、匹配池与对局临时状态（`server/redis/index.coffee`）。
- **Consul / AWS S3**：仅在多节点或云端扩展场景使用，本地单机开发**不需要**。

## 4. 本地资源参考（基线）

- 4 个 Node.js 进程：空闲内存合计约 1.0–1.5 GB（API 随静态资源访问上升至 ~500 MB）。
- PostgreSQL：内存 20–70 MB；Redis：内存 < 10 MB。
- 磁盘占用：源码与资源约 1.3 GB、`node_modules` 约 0.8 GB、`dist` 约 0.5 GB。
