# Docker 本地开发说明

本项目在 `docker/` 目录维护各服务的 Dockerfile，并通过根目录的 `docker-compose.yaml` 编排本地开发环境。

## 1. 常用本地命令

```bash
# 初始化 / 执行最新数据库迁移
docker compose up migrate

# 启动全部本地服务（api / sp / game / worker / db / redis）
docker compose up

# 后台启动并查看指定服务日志
docker compose up -d
docker compose logs -f api sp game worker

# 停止并移除容器（保留 .pgdata 数据）
docker compose down
```

## 2. 单独构建与调试镜像

使用 `scripts/build_container.sh` 可单独构建某个服务的镜像：

```bash
# <service> 可选：api | game | sp | worker
scripts/build_container.sh <service> testing
```

单独运行镜像验证启动（如 `sp`）：

```bash
docker run -it duelyst-sp
```

## 3. 注意事项

- 本地 Postgres 数据挂载在根目录 `.pgdata/`（已被 `.gitignore` 忽略）。
- 修改后端 CoffeeScript/JS 代码后，如容器未热重载，需重启对应服务（`docker compose restart api` 等）。
- 修改前端代码后，需在宿主机重新运行 `yarn build` 更新 `dist/src`。
