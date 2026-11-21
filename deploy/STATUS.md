# EC2 部署状态（2026-11-21 16:22）

## 当前可访问地址

- 游戏：<https://18.188.207.51.sslip.io>
- 测试账号：`ec2check01`（密码在对话里，不在本文件）
- 实例：`18.188.207.51`，AWS us-east-2，t4g.small（2 vCPU / 1.8 GB + 6 GB swap），Ubuntu 24.04 ARM64
- 代码目录：`/home/ubuntu/duelyst`，Compose 目录：`/home/ubuntu/duelyst/deploy`
- 密钥：本机 `.ssh/duelyst-ec2.pem`（已加入 `.gitignore`，勿提交）

## 已完成

- [x] EC2 安装 Docker 29 + Compose v5
- [x] 源码、`serviceAccountKey.json`、生产版 `dist/src`（约 480 MB）上传
- [x] 构建 5 个 ARM64 镜像：api / game / sp / worker / migrate
- [x] Postgres 初始化 + 86 个 migration
- [x] 7 个容器健康运行：api / game / sp / worker / db / redis / caddy
- [x] Caddy 自动 TLS（ZeroSSL，因为 ACME 邮箱用了 example.com 被 Let's Encrypt 拒绝）
- [x] 公网检查通过：
  - `/healthcheck` 200
  - `/version` 200
  - 首页 200
  - `:8001/health` 200
  - `:8000/health` 200
  - Socket.IO 握手 200
- [x] 登录接口通过：返回 API JWT + `firebase_token`
- [x] 注册接口可创建用户（返回 200 `{}`，随后登录成功）

## 待办 / 未验证

- [ ] 浏览器端到端：打开首页 → 登录 → 练习局 → 双人局；确认 `wss://...:8000/8001` 连接成功
- [ ] Firebase custom token → Identity Toolkit → RTDB 读写（最后一次验证因网络挂起被中止）
- [ ] 静态资源从当前网络下载仅约 10–60 KB/s（服务端 Caddy upstream 仅 7 ms，EC2→Cloudflare 81 MB/s，判断是跨境链路/代理问题）
- [ ] 未绑定 Elastic IP：**不要 stop/start 实例**，否则公网 IP 可能变化，`18.188.207.51.sslip.io` 会失效
- [ ] 域名是临时的 sslip.io；换正式域名需要重新构建客户端（API_URL 写死在 bundle 里）
- [ ] ACME 邮箱是占位值 `duelyst-admin@example.com`，建议换真实邮箱
- [ ] 2 GB 内存偏紧（已用约 1.4 GB，swap 约 0.4 GB），多人长期玩建议升 t4g.medium
- [ ] 测试账号 `ec2check01` 可按需删除
- [ ] 本次新增的 `deploy/`、`docs/SELF_HOSTING_ZH.md`、`SERVE_LOCAL_ASSETS` 代码改动尚未提交 Git

## 恢复工作后的检查命令

```bash
# 本机（WSL 重启后）
ssh -F /dev/null -i .ssh/duelyst-ec2.pem \
  -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=.ssh/known_hosts \
  ubuntu@18.188.207.51

# 服务器
cd /home/ubuntu/duelyst/deploy
docker compose ps
docker compose logs --tail=30 caddy api
curl -s localhost:3000/healthcheck
```

## 切换 TUN 后的注意事项

- 给 `18.188.207.51`、`*.sslip.io`、`*.amazonaws.com` 加 DIRECT 规则，避免 AWS 流量绕远。
- 不要把 `*.firebaseio.com` 强制 DIRECT：Firebase 本来就需要代理才能访问。
- 如果 SSH 断开，直接重连即可；EC2 上的服务不受 WSL 重启影响。
