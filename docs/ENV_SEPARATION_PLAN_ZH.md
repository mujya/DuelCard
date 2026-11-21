# 线上 / 线下环境隔离方案（草案，待批准后执行）

> 状态：**方案稿，未执行**。本文只描述现状、目标与改造清单。
> 背景：在 `http://localhost:3000` 打开游戏，却请求 `https://18.188.207.51.sslip.io:8000`，单人局卡在“读取游戏中”。

---

## 1. 根因（已确认）

1. **前端 bundle 在构建期把环境地址写死。** `gulp/bundler.js:60` 用 `envify` 把 `process.env.API_URL`、`FIREBASE_URL`、`NODE_ENV` 等**静态替换**进 `duelyst.js`。
2. **同一份 `dist/src` 同时用于本地和线上。** 当前本地 `dist/src/duelyst.js` 里的 API 地址是 `https://18.188.207.51.sslip.io`（`envify` 烘进去的）——所以本地页面是“本地静态文件 + 线上后端”：
   - 所有 `/api/...` 请求发到 EC2；
   - 游戏服务器地址来自线上 API（`game_server` 字段），于是 socket 连线上 `:8000`；
   - 本地删账号、本地修数据自然“没反应”。
3. **两边共用一个 Firebase RTDB 项目**（`duelyst-new`）：线上账号（`aris / ben / bukoi / crk / ec2check01`）和本地测试账号混在同一棵树里。
4. **线上 8000/8001 没有 TLS**：`deploy/Caddyfile` 里 `{$DOMAIN}:8000`、`:8001` 没有 `https://` 前缀，Caddy 对非 443 端口默认只提供 HTTP，而 `NODE_ENV=production` 的客户端必须走 `wss://` → 握手失败 → 卡加载。
5. `NODE_ENV` 决定 socket 协议（`NetworkManager`：development→`ws`，其他→`wss`），生产页面必须用 `https://` + 证书，dev 页面用 `http://` + `ws`。

结论：**一份构建产物无法同时服务两个环境**，必须按环境分别构建、分别配置、分别存放数据。

---

## 2. 目标架构

| 维度 | 线下 = dev（本地） | 线上 = prod（EC2） |
|---|---|---|
| 入口 | `http://localhost:3000` | `https://18.188.207.51.sslip.io`（未来正式域名） |
| 前端构建 | `NODE_ENV=development`，`API_URL=http://localhost:3000`，不压缩 | `NODE_ENV=production`，`API_URL=https://<域名>`，压缩 |
| socket | `ws://localhost:8000 / 8001` | `wss://<域名>:8000 / 8001` |
| 产物目录 | `dist/dev/src` | `dist/prod/src` |
| 编排 | `docker-compose.yaml`（api/game/sp/worker/db/redis） | `deploy/docker-compose.yml`（+ caddy、migrate） |
| 配置 | `.env.development` | `.env.production`（或服务器上的 `.env`） |
| Postgres | 本机 `./.pgdata` | EC2 数据卷 |
| Redis | 本机容器 | EC2 容器 |
| Firebase RTDB | **dev 项目**（新建 `/ 独立实例） | `duelyst-new`（保留） |
| 对象存储（录像） | 本地/独立 bucket（或禁用） | 现有 S3 bucket |
| 语言 | zh-CN（同一份 locale，构建时复制） | zh-CN |

> 核心原则：**产物按环境构建一次、只部署到对应环境；两个环境不共享任何“会写数据”的后端**（DB / Redis / Firebase / S3）。

---

## 3. 改造清单（批准后执行）

### A. 构建与产物分离

1. **配置按环境加载**
   - 新增 `config/env/development.env`、`config/env/production.env`（或 `.env.development` / `.env.production`）。
   - `config/config.js` 改为按 `NODE_ENV` 选择文件（`dotenv` 读对应文件；**shell 环境变量优先级最高**，便于 CI 覆盖）。
   - 每个文件只放该环境的：`API_URL`、`FIREBASE_URL`、`FIREBASE_API_KEY`、`FIREBASE_PROJECT_ID`、`TOKEN_SECRET`、`POSTGRES_CONNECTION`、`REDIS_HOST`、`DOMAIN`、`ACME_EMAIL`。

2. **npm 脚本**
   ```jsonc
   "build:dev":  "NODE_ENV=development API_URL=http://localhost:3000 gulp build",   // -> dist/dev
   "build:prod": "NODE_ENV=production  API_URL=https://$DOMAIN        gulp build --minify", // -> dist/prod
   "build:dev:register":  "... html:register js:register",   // 注册页属独立产物
   "build:prod:register": "... html:register js:register"
   ```
   - 需要给 `gulp/shared.js` / `gulp/bundler.js` 增加输出目录参数（`dist/dev/src`、`dist/prod/src`）。

3. **构建期防呆断言（关键）**
   - `build:dev` 结束时校验 bundle：不得出现 `https://` 形式的 API_URL，不得出现生产域名；必须出现 `http://localhost:3000`。
   - `build:prod` 结束时校验：不得出现 `localhost`；必须出现生产域名；`NODE_ENV=production`。
   - 任一不符直接 `exit 1`，从机制上杜绝“把线上 bundle 放到本地”。

4. **注册页**：`npm run build` 不会生成 `register.html/js`（需 `html:register` + `js:register`），两个环境的构建脚本都要显式包含它。

### B. 数据隔离

1. **Firebase 新建 dev 项目**（如 `duelyst-dev`），本地 `.env.development` 指向它；把 `serviceAccountKey` 拆成 dev / prod 两份，不提交仓库。
   - 如果短期不想新建项目：至少**不共用**同一 RTDB 树（在 dev 用独立项目，或给所有路径加 `/dev` 前缀——后者要改后端所有路径，成本更高，不推荐）。
2. 本地 Postgres/Redis 独立（已有）；**明确“本地库只放 dev 账号”**，线上库不动。
3. 录像 S3 bucket 按环境区分（dev 可指向本地目录或独立 bucket）。

### C. 线上部署

1. `deploy/Caddyfile`：`https://{$DOMAIN}:8000`、`https://{$DOMAIN}:8001`（仓库已改，**待部署**）。
2. EC2 只挂载 `dist/prod/src`（`deploy/docker-compose.yml` 的 volume 从 `../dist/src` 改为 `../dist/prod/src`）。
3. 部署流程固定为：本机 `build:prod` → 上传 `dist/prod/src` → `docker compose up -d` → 验证 `:8000/:8001` 的 wss。
   - 理由：EC2 只有 2 GB 内存，不建议在服务器上跑前端构建。

### D. 开发体验

1. 本地页面加 `DEV` 标识（`index.html` title 或角标），一眼区分。
2. 文档写明固定端口与对应服务：3000 API、8000 SP、8001 MP。
3. dev / prod 各自注册账号；`deploy/STATUS.md` 记录各环境测试账号（密码不进仓库）。

### E. 文档与检查脚本

1. 新增 `docs/ENV_SEPARATION_ZH.md`（本方案定稿版）。
2. 更新 `README` 的 Quick Start：区分“本地开发”和“线上部署”两条路径。
3. 新增 `scripts/check-env-bundle.sh`：
   ```bash
   # dev
   ! grep -q "sslip.io" dist/dev/src/duelyst.js
   grep -q "http://localhost:3000" dist/dev/src/duelyst.js
   # prod
   grep -q "https://<DOMAIN>" dist/prod/src/duelyst.js
   ! grep -q "localhost" dist/prod/src/duelyst.js
   ```

---

## 4. 实施阶段（建议顺序）

| 阶段 | 内容 | 影响 | 风险 |
|---|---|---|---|
| **P1** | 配置分文件 + `build:dev` / `build:prod` + 构建断言 + 注册页纳入构建 + 重建本地 dev 产物 | 只动构建与配置，不动数据 | 低 |
| **P2** | `dist/dev` / `dist/prod` 目录迁移；本地 compose 挂 dev，EC2 挂 prod | 部署路径变化 | 低（改文档+compose） |
| **P3** | EC2 Caddyfile TLS 修复并部署，验证 `wss://:8000/8001` | 线上可玩性 | 中（需 SSH + 重启 caddy，短暂断服） |
| **P4** | Firebase dev 项目分离 + 凭据拆分 + 清理 dev 数据 | 账号/数据不再互通 | 中（要建项目、换凭据、重测登录） |
| **P5** | DEV 标识、检查脚本、文档 | 体验/防呆 | 低 |

---

## 5. 决策与状态（2026-11-21 17:12 更新）

- ✅ **Firebase 新建 dev 项目**：已确认。需在 Firebase 控制台创建 `duelyst-dev`（见 §7.1）。
- ✅ **代码托管用 GitHub**：已确认。需确定仓库地址（见 §7.2）。
- ⏳ 待确认：2. 产物目录方案；3. 线上/本地数据保留策略；4. prod 构建位置；5. 是否加 staging。

（原决策点：）
1. ~~**Firebase 是否新建 dev 项目？**~~ ✅ 是
2. **产物目录方案**：`dist/dev` + `dist/prod`（推荐，改动小）还是两个独立 git worktree（更彻底，但要两套 checkout）？
3. **线上数据**：EC2 现有账号/对局全部保留？本地 dev 库是否直接清空重建？
4. **prod 构建在哪里做**：本机构建后上传（推荐）还是 EC2 上构建？
5. 是否再加一个 **staging**（预发布）环境，还是 dev/prod 两套就够？

---

## 6. 当前状态快照（本次会话，截至 17:06）

- 本地 `dist/src` 已用 `API_URL=http://localhost:3000` 重建完成：bundle 中 `sslip.io` 出现 **0** 次、`localhost:3000` **148** 处；`NODE_ENV=development`（socket 走 `ws`）。
- 构建的 `clean:all` 顺带删掉了 `dist/src/register.html` / `register.js`；**恢复命令**：`node node_modules/gulp/bin/gulp.js html:register js:register`（需要 `BABEL_CACHE_PATH`、`FIREBASE_URL` 环境变量，见操作记录）。
- `.env` 新增一行 `API_URL=http://localhost:3000`（本次唯一配置改动）。
- EC2 的 8000/8001 仍无 TLS；`deploy/Caddyfile` 已在仓库中改成 `https://` 前缀，**尚未部署**。
- 浏览器 localStorage 里仍是线上账号的 token；切回本地需退出登录/清站点数据后重新注册（本地 `users` 表目前为空）。
- 两个环境共享 Firebase `duelyst-new`（线上账号 `aris/ben/bukoi/crk/ec2check01` 等仍在，未清理）。


---

## 7. GitHub 托管 + Firebase dev 项目（新增）

### 7.1 Firebase dev 项目创建（需你在控制台操作）

1. Firebase 控制台 → 新建项目 `duelyst-dev`（地区任选，建议与 prod 一致）。
2. 启用 **Realtime Database**（测试模式或复制 prod 规则），记下数据库 URL（形如 `https://duelyst-dev-default-rtdb.<region>.firebasedatabase.app`）。
3. 启用 **Authentication**（无需开启匿名登录；自定义令牌走 `accounts:signInWithCustomToken`）。
4. 项目设置 → 服务账号 → 生成新的私钥 → 保存为仓库外的 `serviceAccountKey.dev.json`（**不提交**）。
5. 项目设置 → 常规 → Web API Key → 填入 `.env.development` 的 `FIREBASE_API_KEY`。
6. 把 Realtime Database 规则同步为 prod 的规则（或 dev 用更宽松的规则，但建议保持一致以免行为差异）。

`.env.development`（本地，gitignored）示例：

```dotenv
NODE_ENV=development
API_URL=http://localhost:3000
FIREBASE_URL=https://duelyst-dev-default-rtdb.<region>.firebasedatabase.app/
FIREBASE_PROJECT_ID=duelyst-dev
FIREBASE_API_KEY=<dev web api key>
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.dev.json
TOKEN_SECRET=<dev 随机值，与 prod 不同>
POSTGRES_CONNECTION=pg://duelyst:duelyst@db/duelyst
REDIS_HOST=redis
```

> 仓库里只提交 `.env.development.example`（占位值），真实文件进 `.gitignore`。

### 7.2 GitHub 仓库与分支模型

当前 `origin` 指向上游 `open-duelyst/duelyst`，应先改名，再添加你们自己的仓库：

```bash
git remote rename origin upstream      # 上游保留，便于同步
git remote add origin git@github.com:<你的账号>/<仓库名>.git
git push -u origin main
```

建议模型：

| 分支/标签 | 用途 | 触发构建 |
|---|---|---|
| `main` | 生产（对应 EC2） | 打 tag `v*` 时构建 **prod** 产物 |
| `dev` | 开发（对应本地） | push 时构建 **dev** 产物并跑构建断言 |
| `feature/*` | 功能分支 | PR 检查（lint + 单测 + dev 构建断言） |

- 仓库建议先 **private**（`deploy/STATUS.md` 里有服务器 IP 与密钥路径等内部信息，适合走私有仓库或先脱敏）。
- 不允许直接 push `main`，走 PR。
- 提交前确认 `git status` 不包含：`.env*`（除 example）、`serviceAccountKey*.json`、`*.pem`、`dist/`、`开发资源/`（两版 7.5 MB bundle + 分析产物）、`.l10n_tmp/`、`.codegraph/`、`.babel-cache.json`。

### 7.3 CI（GitHub Actions）

在现有 `.github/workflows/` 基础上新增两个工作流（与上游 workflow 并存，可按需删除上游无关的）：

1. `build-dev.yaml`：push 到 `dev` → 安装依赖 → `npm run build:dev` + `npm run build:dev:register` → 运行 `scripts/check-env-bundle.sh dev` → 上传 `dist/dev` 作为 artifact（供本地/测试机下载）。
2. `build-prod.yaml`：push tag `v*` → `npm run build:prod` + register → 断言 → 上传 `dist/prod` artifact；可选再走一步 `deploy-ec2`（用 `secrets.EC2_SSH_KEY`/`EC2_HOST`，默认手动触发）。

密钥管理：GitHub → Settings → Environments 建 `dev` / `production` 两组 Environment secrets，分别放 Firebase 凭据、`TOKEN_SECRET`、`EC2_*`；不要用仓库级共享 secret，避免 dev 流程误用 prod 凭据。

### 7.4 首次提交范围（建议）

- 提交：`app/localization/`（zh-CN、index.coffee）、`app/ui/templates/item/settings_menu.hbs`、`app/ui/views/item/settings_menu.js`、`gulp/localization.js`、`deploy/`（Caddyfile 已改 https、compose、STATUS 脱敏后）、`docs/`、`.env.development.example`、`.gitignore` 更新。
- 不提交：`开发资源/`（社区汉化包与分析产物，可按需另存）、`dist/`、`.l10n_tmp/`、`.codegraph/`、`.babel-cache.json`、所有密钥文件。
- 需要 `.gitignore` 追加：`/.l10n_tmp/`、`/.codegraph/`、`/.babel-cache.json`、`/开发资源/`、`serviceAccountKey.dev.json`、`*.pem`。

### 7.5 执行顺序建议（更新后的 P 序列）

1. **P1** 构建/配置分离 + 构建断言 + 注册页纳入（不涉及数据）。
2. **P2** `dist/dev` / `dist/prod` 目录与 compose 挂载迁移。
3. **P3** GitHub 仓库建立、`.gitignore` 收口、首次提交与 CI。
4. **P4** Firebase dev 项目接入、`.env.development` 切换、本地登录/对局验证。
5. **P5** EC2 Caddyfile 部署 + wss 验证（线上）。
6. **P6** DEV 标识、检查脚本、文档定稿。
