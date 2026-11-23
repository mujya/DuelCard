# Antigravity (AGY) Project Rules

> Authoritative English rule file for AGY.
> Human-readable Chinese mirror: [RULES.zh.md](RULES.zh.md).
> **Sync rule**: Any addition, edit, or deletion MUST be applied simultaneously to both `RULES.en.md` and `RULES.zh.md`.

## 1. Language & Communication

- Always respond to the user in **Chinese**.
- Treat `docs/AGENT/RULES.en.md` as the primary instruction source for AGY, and keep `docs/AGENT/RULES.zh.md` strictly 1-to-1 synchronized.

## 2. Project Scope & Environment

- Focus strictly on **local development (`dev`)**.
- Production (`prod`), Alibaba Cloud, and AWS/EC2 deployment tasks are **shelved**. Do not create cloud deployment configs, prod env files, or infra docs unless explicitly requested.
- Never commit secrets or credentials (`.env*` except `*.example`, `serviceAccountKey*.json`, `.ssh/`, `*.pem`, `.server_key*`).

## 3. Directory Hygiene (Anti-Bloat)

- Put all temporary artifacts—build/debug logs (`logs/`), one-off scripts or test outputs (`scratch/`), and unfinalized notes (`notes/`)—inside `.dev-tmp/`.
- Never leave temporary files (`.tmp*`, `*.log`, scratch scripts, draft `.md`) in the repository root or `docs/`.
- Keep `docs/` concise and in **Chinese** (except `docs/AGENT/RULES.en.md`). Prune outdated sections when architecture or workflows change.

## 4. Codebase & Build Conventions

- Respect the CoffeeScript / JavaScript hybrid codebase (`app/`, `server/`, `worker/`). Follow `.eslintrc.json` and `coffeelint.json`.
- Remember `gulp` uses `envify` to bake `API_URL`, `FIREBASE_URL`, `FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID`, and `NODE_ENV` into `dist/src` at build time; changing them requires rebuilding via `yarn build`.
- Preserve the Simplified Chinese localization (`app/localization/locales/zh-CN/`, default locale `zh-CN`) and the Firebase v8 regional RTDB compat layer (`app/common/firebase_compat.js`, `gulp/firebase_esm.js`).
- Run relevant lint/test commands (`yarn lint:js`, `yarn lint:coffee`, `yarn test:unit`) to verify code changes when applicable.

## 5. Safety & Git Discipline

- Ask for explicit confirmation before destructive actions (deleting user credentials/keys, wiping `.pgdata/`, resetting git history, or force-pushing).
- Check `git status` after multi-file edits to ensure no stray or unintended files remain.
- Commit and push changes to `origin` on the user's behalf when development tasks are complete, using **Chinese commit messages**.
