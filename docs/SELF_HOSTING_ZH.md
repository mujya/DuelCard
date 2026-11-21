# 让别人玩 OpenDuelyst：免费 / 低价部署指南

本文说明如何把这份 OpenDuelyst 服务端放到公网上，让其他人**只用浏览器**就能玩，
并给出一套经过验证的单机 Docker Compose 部署配置（见 `deploy/`）。

---

## 0. 先说结论

| 方案 | 费用 | 评价 |
|------|------|------|
| **Oracle Cloud Always Free（推荐白嫖）** | ¥0 | 4 OCPU / 24 GB 内存 / 200 GB 磁盘 / 10 TB 出网，跑这套服务绰绰有余。需要信用卡注册，ARM 机器，热门区域可能开不出实例 |
| **Hetzner CX22（推荐低价稳定）** | 约 €4–6/月（¥35–50） | 2 vCPU / 4 GB / 40 GB / 20 TB 流量，x86，开通即用，最省心 |
| **AWS EC2（已有 AWS 账号）** | 免费期 ¥0，之后约 $18–31/月 | 一台 EC2 + 同一套 Compose 即可；新账户 Free Plan 只有 6 个月，长期比 Hetzner 贵 |
| 家用电脑 + Tailscale | ¥0 | 只给朋友玩、不公开；朋友要装 Tailscale，电脑要保持开机 |
| 家用电脑 + Cloudflare Tunnel | ¥0 + 域名 | 客户端把 WebSocket 端口写死为 8000/8001，隧道只能走 443，需要改代码，不是开箱即用 |
| Render / Koyeb / Fly.io / Railway 免费层 | “免费” | **不适合**：512 MB 内存、休眠、免费库会删、 arbitrary ports 不支持，详见第 2 节 |
| 每个玩家自己电脑跑 Docker | ¥0 | 每人要自己建 Firebase、装 Docker、下载 5 GB，非技术玩家基本不可行 |

**推荐组合：Oracle Always Free（能开出机器就用）+ 一个域名 + Firebase Spark 免费版。**
开不出 Oracle 就用 Hetzner CX22，一个月几十块钱，稳定性好得多。

玩家端**不需要安装任何东西**：发一个 `https://play.example.com` 网址即可，手机浏览器也能玩。
仓库里的 Electron 桌面版只是套壳，仍然连同一台服务器，部署时不必打包分发。

---

## 1. 这套游戏为什么不能“静态托管”

Duelyst 不是纯前端游戏，它需要一整套常驻服务：

```
玩家浏览器 ──HTTPS──> Caddy ──> API (Express, 3000)      页面 + HTTP API + 静态资源
     │                  ├──────> Game (socket.io, 8001)  多人对战
     │                  └──────> SP   (socket.io, 8000)  单机/AI 对战
     │
     └── 直连 Firebase Realtime Database（对局步骤、聊天等实时数据）

Worker <── Redis 队列 <── API / Game / SP
API、Worker <──> Postgres（用户、卡组、战绩）
```

由此带来几个硬性约束：

1. **四个 Node 进程 + Postgres + Redis**，空闲内存约 1.2–1.5 GB，加上系统建议 2 GB 起，4 GB 舒适。
2. **客户端把游戏服务器端口写死**：`app/sdk/networkManager.coffee` 里 SP 用 `:8000`、MP 用 `:8001`。
   所以公网必须能访问这两个端口，并且要有 TLS（生产构建用 `wss://`）。
3. **构建时把 Firebase URL 和 API URL 写进前端 bundle**（`gulp/bundler.js` 的 envify），
   改域名必须重新构建客户端，不是改环境变量就能生效。
4. **磁盘占用不小**：`dist/src` 约 0.5 GB，镜像约 1.2 GB/个，数据库 1 GB 起。
5. **必须有一个 Firebase 项目**（Realtime Database），这是外部依赖，不能在本机轻松替代。

因此 Vercel / Netlify / Cloudflare Pages 这类纯静态或 Serverless 平台直接排除；
Render / Koyeb 的免费实例（512 MB、0.1 CPU、15 分钟无请求休眠）也扛不住 socket.io 长连接和这套内存占用。

---

## 2. 免费 PaaS 为什么不行（省得你踩坑）

- **Render 免费 Web Service**：512 MB / 0.1 CPU，15 分钟无流量休眠；免费 Postgres 创建 30 天后删除。
  游戏一局几十分钟，休眠/重启会直接断线。
- **Fly.io**：2026 年已没有免费层，新组织只有 7 天/1 美元试用，之后按量付费。
- **Railway**：只有 5 美元试用额度，之后 Hobby 5 美元/月起，且多服务、持久卷另外算。
- **Koyeb 免费层**：一个 512 MB 服务、scale-to-zero，无法同时跑 API/Game/SP/Worker。
- **Cloudflare Workers / Pages**：不能跑长连接 socket.io、不能跑 Postgres/Redis。
- **Oracle / GCP / AWS 的“免费虚拟机”**：
  - Oracle Always Free A1 的 4C24G 规格够用；
  - GCP e2-micro、AWS 老式免费 t3.micro 都只有 1 GB 内存，跑不动；
  - AWS 新账户的 Free Plan 是 **$100–200 抵扣金、6 个月**，到期后账户会自动关闭或需要升级付费，
    适合短期试玩，不是长期免费方案。

结论：**免费要么用 Oracle 的 ARM 大机器，要么用自己的电脑 + 内网穿透；低价直接买 2C4G VPS 最省事。**

---

## 3. 推荐架构

单台服务器，Docker Compose 起 7 个容器：

```
                 ┌────────────────────────────────────────────┐
  Internet ──────┤ Caddy :80/:443  -> api:3000                │
                 │       :8000     -> sp:8000   (wss)         │
                 │       :8001     -> game:8001 (wss)         │
                 │                                            │
                 │ api / game / sp / worker                   │
                 │ db (Postgres 13)  redis (Redis 6)          │
                 └────────────────────────────────────────────┘
                              │
                              └──> Firebase Realtime Database（外部，免费 Spark 计划）
```

Caddy 会自动申请/续期 Let's Encrypt 证书，并反代三个端口。
配置在 [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) 和 [`deploy/Caddyfile`](../deploy/Caddyfile)。

### 端口

| 端口 | 用途 | 是否对公网开放 |
|------|------|----------------|
| 80 | ACME 证书验证 / HTTP 跳转 | 是 |
| 443 | 网页 + HTTP API | 是 |
| 8000 | 单机/AI socket.io（wss） | 是 |
| 8001 | 多人 socket.io（wss） | 是 |
| 3000 / 5432 / 6379 | 内部服务 / 数据库 | **否**（只在 Docker 网络内） |

---

## 4. 准备工作

### 4.1 Firebase（免费）

1. 建一个 Firebase 项目，创建 **Realtime Database**，区域必须选 **United States (US Central)**；
   新加坡/欧洲区的 URL 与这套旧版 Firebase 客户端不兼容。
2. 把仓库根目录的 [`firebaseRules.json`](../firebaseRules.json) 内容粘贴到 Realtime Database 的 Rules 里并发布。
3. 项目设置 → 常规 → 复制 **Web API Key**（构建客户端用，不是机密）。
4. 项目设置 → 服务账号 → 生成新的私钥，保存为仓库根目录的 `serviceAccountKey.json`
   （角色用 Firebase Realtime Database Admin 即可）。
5. 可选：在 Firebase 里把 `/system-status/shop_enabled` 设为 `true` 打开商店。

> Spark 免费计划限制：**同时连接数 100**、存储 1 GB、每月下载 10 GB。
> 对朋友小圈子够用；如果同时在线接近 100 人，需要升级 Blaze（按量计费，超出免费额度后通常每月几美元）。

### 4.2 域名

买一个便宜域名（约 ¥60–80/年），把 `play.example.com` 的 A 记录指向服务器 IP。
Caddy 需要 80 端口做 HTTP 验证。也可以用 DuckDNS 之类的免费二级域名，但长期稳定性不如自己的域名。

### 4.3 服务器

**Oracle Always Free**：

- 创建 Ampere A1 Flex 实例：4 OCPU / 24 GB（Always Free 额度内），系统选 Ubuntu 22.04/24.04。
- 注意 ARM64：本项目基础镜像是 `node:24-bookworm-slim`，支持 arm64，Compose 会从源码构建；
  个别原生模块如遇问题，换 x86 的 Hetzner 更稳。
- 注册通常要国际信用卡验证；热门区域 A1 容量经常售罄，可以换区域或过几天再试。

**Hetzner CX22**：

- 2 vCPU / 4 GB / 40 GB，Ubuntu 24.04，月费约 €4–6（含 IPv4）。
- 对几十人同时在线的朋友局完全够用。

**AWS EC2（如果你已经有 AWS 账号）**：

- **不要**用 ECS / Fargate / App Runner / Elastic Beanstalk：4 个服务 + ALB + NAT 网关，
  一个月很容易到 $60–100+；单台 EC2 跑 Docker Compose 才是正确姿势。
- 推荐 **t4g.medium（2 vCPU / 4 GB）**，us-east-2 按需约 **$24.5/月**；
  **t4g.small（2 vCPU / 2 GB）** 约 **$12.3/月**，跑得动但偏紧（建议加 2 GB swap）。
- 不想折腾 EC2 的安全组/EBS/弹性 IP，可以直接用 **Lightsail 4 GB 套餐（$24/月，
  2 vCPU / 4 GB / 80 GB SSD / 4 TB 流量，含静态 IP）**，控制台更简单，部署步骤完全一样。
- 磁盘选 **40 GB gp3**（8 GB 默认盘不够 Docker 镜像 + dist）；公网 IPv4 约 **$3.65/月**；
  出网每月 100 GB 免费，这套游戏流量远低于此。
- 安全组只开：22（你的 IP）、80、443、8000、8001；**不要**开 5432/6379。
- 新账户的 **Free Plan** 有 $100–200 抵扣金、有效期 6 个月；6 个月后账户会自动关闭，
  想长期用要在到期前升级成付费计划。开一个 **AWS Budgets 告警**（例如 $20）防止意外账单。
- t4g 是 ARM64，Ubuntu 选 **24.04 Arm64** AMI；t4g.small 构建镜像时容易 CPU 积分限速，
  客户端和镜像建议在本机构建，或临时换大实例构建后再降配。
- 区域：**us-east-2（俄亥俄）** 对美欧玩家合适；亚洲玩家可换 `ap-northeast-1`（东京）或
  `ap-southeast-1`（新加坡）降低延迟。但 Firebase 库在美中，玩家到 Firebase 仍有一段公网延迟；
  如果玩家主要在中国大陆，先解决 Firebase 访问问题（见第 11 节）。

服务器上装好 Docker Engine + Compose 插件即可。

### 4.4 构建环境

客户端构建需要 Node.js 24 + Yarn 4（仓库已带 `packageManager`），内存建议 4 GB 以上。
可以在自己电脑上构建后把 `dist/src` 传上去，也可以直接在服务器上构建（Oracle 24 GB 内存很轻松）。

---

## 5. 构建客户端

在仓库根目录：

```bash
corepack enable
corepack yarn install
yarn tsc:chroma-js

NODE_ENV=production \
FIREBASE_URL="https://你的项目-default-rtdb.firebaseio.com/" \
FIREBASE_API_KEY="你的 Firebase Web API Key" \
API_URL="https://play.example.com" \
yarn build
```

要点：

- `FIREBASE_URL` **必须以 `/` 结尾**，且必须是 `firebaseio.com` 域名（构建脚本会校验）。
- `API_URL` 填最终玩家访问的地址，**不要带结尾斜杠**。它会被写死进 `duelyst.js`。
- 生产构建会强制 WebSocket 使用 `wss://`，所以必须配 TLS（Caddy 已处理）。
- 构建完成后产物在 `dist/src`，约 500 MB；`dist/src/index.html` 必须存在。

构建机与服务器不是同一台时，把产物传上去：

```bash
rsync -av --delete dist/src/ user@server:/opt/duelyst/dist/src/
```

---

## 6. 部署服务端

在服务器上：

```bash
sudo mkdir -p /opt/duelyst && sudo chown "$USER":"$USER" /opt/duelyst
git clone <你的仓库地址> /opt/duelyst
cd /opt/duelyst

# 1) Firebase 服务账号密钥
scp 本地路径/serviceAccountKey.json ./serviceAccountKey.json

# 2) 客户端产物（如果第 5 步不是在服务器上构建的）
#    dist/src 必须存在，否则容器里会是一个空目录，网页 404/500

# 3) 配置
cd deploy
cp .env.example .env
$EDITOR .env        # 填 DOMAIN、ACME_EMAIL、FIREBASE_URL、FIREBASE_API_KEY、TOKEN_SECRET、POSTGRES_PASSWORD
```

生成随机密钥：

```bash
openssl rand -hex 32     # 填入 TOKEN_SECRET
openssl rand -hex 24     # 填入 POSTGRES_PASSWORD
```

启动：

```bash
cd /opt/duelyst/deploy
docker compose up -d --build
```

首次构建需要下载依赖并编译 `bcrypt`，2C4G 机器大约 10–20 分钟。
Compose 会先跑 `migrate`（数据库迁移），成功后再启动 API。
观察状态和日志：

```bash
docker compose ps
docker compose logs -f caddy api game sp worker
```

看到 Caddy 成功签发证书、`Duelyst 'production' started on port 3000 (local assets)` 即成功。

### 关于 `SERVE_LOCAL_ASSETS`

原项目的 production 模式会去 S3/CloudFront 下载 `index.html`，并且把静态资源放 CDN。
本仓库新增了 `SERVE_LOCAL_ASSETS=true` 配置：production 模式下直接由 API 提供 `dist/src`，
不再依赖 AWS。`deploy/docker-compose.yml` 已默认打开，并把 `dist/src` 只读挂载进 API 容器。

---

## 7. DNS、防火墙与证书

- DNS：`play.example.com` → 服务器公网 IP。
  **如果域名托管在 Cloudflare，请把这条 A 记录设为“仅 DNS”（灰色云朵），不要开代理**：
  Cloudflare 代理只转发 80/443 等少数端口，而客户端要直连 `:8000`/`:8001`，
  开了橙云会导致 WebSocket 连不上。
- 防火墙放行 TCP **80、443、8000、8001**。
  - Ubuntu：`sudo ufw allow 80,443,8000,8001/tcp`
  - Oracle：除了安全列表（Security List / NSG），Ubuntu 镜像里还有 iptables 规则，需要一并放行，
    否则会出现“安全组开了但外网还是连不上”。
- Caddy 首次启动会自动申请证书；如果失败，先确认 80 端口可达、DNS 已生效：
  `docker compose logs caddy`。
- **不要**把 5432、6379 映射到公网。

---

## 8. 第一次进游戏

1. 浏览器打开 `https://play.example.com`。
2. 注册账号、登录，先打一局 Practice（单机/AI）确认：
   - 页面能加载；
   - 浏览器 DevTools → Network → WS，能看到 `wss://play.example.com:8000/...` 连接成功。
3. 再开两个浏览器窗口（或找朋友）测试多人对战；多人会连 `:8001`。
4. 本地配置默认所有阵营/卡牌解锁，新账号有额外金币和魂力，适合朋友间随便玩。

如果 WS 连不上，按顺序排查：防火墙 8000/8001 → Caddy 是否在监听 → 证书是否有效 →
浏览器控制台是否报 mixed content（说明页面是 https 但客户端连了 ws）。

---

## 9. 日常运维

### 更新版本

```bash
cd /opt/duelyst
git pull
# 重新构建客户端（改了前端代码/域名时必须）
NODE_ENV=production FIREBASE_URL=... FIREBASE_API_KEY=... API_URL=... yarn build
cd deploy
docker compose up -d --build
```

只改服务端代码时，`docker compose up -d --build` 会重建镜像；客户端不用动。
只改客户端时，重建 `dist/src` 后重启 api 容器即可（`docker compose restart api`）。

### 备份 Postgres

```bash
cd /opt/duelyst/deploy
docker compose exec -T db pg_dump -U duelyst duelyst | gzip > backup-$(date +%F).sql.gz
```

恢复：

```bash
gunzip -c backup-2026-11-21.sql.gz | docker compose exec -T db psql -U duelyst -d duelyst
```

Redis 里是队列/临时对局数据，通常不需要备份；用户、卡组、战绩都在 Postgres。
Firebase 里也有部分用户数据（任务、聊天等），重要的话另外用 Firebase 导出。

### 看资源占用

```bash
docker stats
```

空闲时 4 个 Node 进程各约 150–300 MB；如果 4 GB 机器吃紧，可以给 Node 加
`NODE_OPTIONS=--max-old-space-size=384`（在 `deploy/docker-compose.yml` 的 `x-node-common` 里加）。

---

## 10. 零成本 / 内网替代方案

如果一分钱都不想花，而且只给熟人玩：

### 家用电脑 + Tailscale（推荐零成本）

- 服务器跑在自己电脑上，朋友装 Tailscale 并加入你的 tailnet，通过
  `http://<你的机器名>:3000` 访问；WebSocket 走同一个 tailnet 的 8000/8001。
- 这种场景用**开发模式构建**（`NODE_ENV=development`，客户端用 `ws://`），
  并把 `API_URL` 设成 Tailscale 里那台机器的地址；不需要域名和证书。
- 缺点：你的电脑必须开机、朋友要装 Tailscale、上传带宽决定体验。

### 家用电脑 + Cloudflare Tunnel

- 免费，但 cloudflared 只暴露一个 443 域名；而客户端写死了 `:8000`/`:8001`。
  想走隧道需要改 `app/sdk/networkManager.coffee` 和两个 socket 服务，改成同域名路径反代
  （例如 `/sp`、`/game`），属于代码改动，不在本指南的开箱即用范围内。
- 有公网 IP 的话，直接端口映射 + Caddy 也行，但家宽上传和稳定性通常不如 VPS。

### 局域网 / 宿舍

- 同一局域网内直接访问 `http://<主机IP>:3000`，开发模式构建即可，免费且延迟最低。
- Firebase 仍然需要公网（国内网络访问 Firebase 需要额外条件，见下）。

---

## 11. 重要限制与注意事项

1. **Firebase 是单点外部依赖**：客户端对局数据直接写 Firebase。Firebase 挂了，游戏就进不去。
2. **国内网络**：`*.firebaseio.com` 在中国大陆无法直接访问，玩家需要代理；如果目标玩家主要在国内，
   这套架构的体验会很差。服务器放国内还需要域名备案（ICP），而且 Firebase 依然连不上。
   真要面向国内，需要把 Firebase 实时层替换成自建服务，这是另一个大工程，另议。
3. **Spark 100 并发连接**：超过会拒绝新连接；升级 Blaze 即可，费用按用量。
4. **单点故障**：单机部署没有高可用，重启/升级会中断进行中的对局；朋友局可以接受，公开社区需要多实例和滚动升级。
5. **安全**：`serviceAccountKey.json`、`deploy/.env` 都不要提交到 Git；不要公网暴露 Postgres/Redis；
   `TOKEN_SECRET` 必须随机且够长。
6. **ARM64**：Oracle A1 是 ARM，镜像从源码构建，理论兼容；若某个原生依赖编译失败，改用 x86 VPS 最省事。

---

## 12. 一句话总结

- **想白嫖**：Oracle Always Free A1（4C24G）+ 域名 + `deploy/docker-compose.yml`，玩家打开网址即玩。
- **想省心**：Hetzner CX22（约 ¥40/月）+ 同一套 Compose。
- **已经有 AWS**：一台 t4g.medium/small + 同一套 Compose；新账户免费期 6 个月，之后约 $18–31/月。
- **只给熟人**：家用电脑 + Tailscale，零成本但需要朋友装客户端。
- 免费 PaaS 和“每人本地跑”都不适合这套需要 4 个常驻进程 + Redis/Postgres + Firebase 的游戏。
