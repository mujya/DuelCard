# Gulp 构建说明

主入口为根目录 `gulpfile.babel.js`，各子任务拆分在 `gulp/` 目录下。可通过 `npx gulp --tasks` 查看全部任务，日常推荐通过 `package.json` 中的 `yarn` 脚本调用。

## 1. 常用构建命令

```bash
yarn build        # 完整构建前端到 dist/src（默认使用 2GB 堆内存）
yarn build:app    # 仅构建应用代码（不含全量资源复制）
yarn minify       # 压缩构建（--minify=true）
yarn rsx:copy     # 复制 app/resources 资源到 dist
```

## 2. 核心子任务说明（`gulp/`）

| 文件 | 对应任务 | 说明 |
|---|---|---|
| `clean.js` | `clean:all` / `clean:desktop` | 清理构建产物目录 |
| `css.js` | `css` | 编译 `app/ui/styles` 下的 SCSS 为 CSS |
| `html.js` | `html` / `html:register` | 将 `index.hbs`、`index.register.hbs` 编译为 HTML 并注入配置变量 |
| `vendor.js` | `vendor` | 按固定顺序拼接 jQuery、Backbone、Marionette、`backfire`、Cocos2d-JS 等外部依赖为 `vendor.js` |
| `bundler.js` | `js` | 使用 Browserify 打包主逻辑，依次应用 `coffeeify`、`hbsfy`、`glslify`、`envify` 及 Firebase ESM 转译 |
| `bundler.register.js` | `js:register` | 打包独立注册页脚本（`yarn build` 默认不包含注册页，如需更新注册页需单独跑 `html:register` + `js:register`） |
| `firebase_esm.js` | — | 将 `firebase@8` 的 ESM 模块转译为 Browserify 可打包的 CommonJS |
| `localization.js` | `localization` | 合并与复制多语言 JSON 资源（含 `zh-CN` / `zh-TW` / `en` 等） |
| `rsx.js` | `rsx:packages` / `rsx:copy` | 生成客户端资源包清单 `app/data/packages.js` 并复制美术/音频资源 |

## 3. 构建注意事项

- **环境变量在构建期静态替换**：`envify` 会把 `API_URL`、`FIREBASE_URL`、`FIREBASE_API_KEY`、`FIREBASE_PROJECT_ID`、`NODE_ENV` 直接写死到 `duelyst.js` 中，修改 `.env` 后必须重新构建。
- **Node 23+ 兼容**：`gulpfile.babel.js` 内已注入已移除的 `util.is*` shim，切勿随意删除。
- **内存占用**：前端打包需要 `--max_old_space_size=2048`，请始终使用 `yarn build` 而非裸跑 `gulp build`。
