# Antigravity (AGY) 项目协作规则

> 本文件供用户阅读；AGY 阅读英文版：[RULES.en.md](RULES.en.md)。
> **同步约定**：任何规则的新增、修改或删减，都**必须**同时更新 `RULES.en.md` 与 `RULES.zh.md`，保持一一对应。

## 1. 语言与沟通

- 对用户一律使用**中文**回复。
- AGY 以 `docs/AGENT/RULES.en.md` 作为执行依据，并与 `docs/AGENT/RULES.zh.md` 保持严格同步。

## 2. 开发范围与环境边界

- 当前仅聚焦**本地开发环境（`dev`）**。
- 生产环境（`prod`）、阿里云与 AWS/EC2 部署相关工作已**暂缓搁置**；除非明确要求，不新增云端部署配置、prod 环境文件或运维文档。
- 严禁提交任何密钥与凭据（除 `*.example` 外的 `.env*`、`serviceAccountKey*.json`、`.ssh/`、`*.pem`、`.server_key*`）。

## 3. 目录整洁与防膨胀

- 所有本地临时产物统一放入 `.dev-tmp/`：构建与调试日志放 `logs/`、一次性脚本与测试输出放 `scratch/`、未定稿草稿放 `notes/`。
- **禁止**在仓库根目录或 `docs/` 中遗留临时文件（`.tmp*`、`*.log`、临时脚本、草稿 `.md`）。
- `docs/` 保持精简且统一使用**中文**（`docs/AGENT/RULES.en.md` 除外）；架构或流程变化时同步删减过期内容。

## 4. 代码与构建约定

- 尊重现有 CoffeeScript / JavaScript 混合代码库（`app/`、`server/`、`worker/`），遵循 `.eslintrc.json` 与 `coffeelint.json`。
- `gulp` 会在构建期通过 `envify` 将 `API_URL`、`FIREBASE_URL`、`FIREBASE_API_KEY`、`FIREBASE_PROJECT_ID`、`NODE_ENV` 静态写入 `dist/src`，修改环境变量后必须执行 `yarn build` 重建。
- 修改 UI、鉴权或构建链路时，保持简体中文本地化（`app/localization/locales/zh-CN/`，默认语言 `zh-CN`）及 Firebase v8 区域 RTDB 兼容层（`app/common/firebase_compat.js`、`gulp/firebase_esm.js`）完整可用。
- 代码改动后，按需运行相关检查与测试（`yarn lint:js`、`yarn lint:coffee`、`yarn test:unit`）进行验证。

## 5. 安全与 Git 纪律

- 执行破坏性操作前必须先征得用户确认（删除用户密钥/凭据、清空 `.pgdata/`、重置 Git 历史、强推远端等）。
- 多文件修改完成后检查 `git status`，确保没有残留多余或意外文件。
- 开发任务完成后由 AGY 代为提交并推送至 `origin`，提交说明（commit message）统一使用**中文**。
