# 开发与测试规范

## 1. 常用开发目录

- `app/`：前端客户端与前后端共享的 `sdk/` 游戏规则引擎
- `server/`：API、多人对战、单人/AI 对战后端服务与数据库迁移
- `worker/`：Redis/Kue 异步任务消费者
- `config/`：后端环境变量与各环境 JSON 配置
- `gulp/` & `gulpfile.babel.js`：前端构建流水线
- `packages/`：项目内嵌修改的本地依赖（`backfire`、`chroma-js` 等）
- `test/`：Mocha 单元测试与集成测试
- `.dev-tmp/`：统一本地开发临时目录（日志、一次性脚本、草稿，不入 Git）

## 2. 代码风格与语言约定

项目处于 CoffeeScript 向 JavaScript / TypeScript 渐进演进状态：

- **JavaScript（ESLint）**：配置见 `.eslintrc.json`
  - 检查：`yarn lint:js`（全量：`yarn lint:js:all`）
  - 自动格式化：`yarn format:js`
- **CoffeeScript（CoffeeLint）**：配置见 `coffeelint.json`
  - 检查：`yarn lint:coffee`（全量：`yarn lint:coffee:all`）
- **TypeScript**：新代码可按需使用 TS，配置见 `tsconfig.json`，类型检查执行 `yarn tsc`。

## 3. 运行测试

使用 Mocha + Chai（配置见 `.mocharc.js`）：

```bash
# 单元测试（全部）
yarn test:unit

# 按模块跑单元测试
yarn test:unit:sdk
yarn test:unit:session
yarn test:unit:firebase

# 集成测试（需先启动本地 Postgres / Redis）
yarn test:integration
```

## 4. 协作与 Hygiene 约定

- 临时文件、构建日志与调研草稿统一放入 `.dev-tmp/`，不要污染根目录或 `docs/`。
- Agent 协作规则见 [AGENT/RULES.zh.md](AGENT/RULES.zh.md)（英文版 [AGENT/RULES.en.md](AGENT/RULES.en.md)）。
