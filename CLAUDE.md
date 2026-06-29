# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Two things live together in one git repo (root = `aws-learning/`, remote `Adophlidu/aws-learning`):

1. **AWS learning materials** — `ROADMAP.md` (curriculum + progress) and `notes/` (deep-dive study notes + architecture diagrams). These are intentionally committed.
2. **`playground/`** — a real, deployed full-stack project: **GitHub Profile Collector**. User submits a GitHub token → backend fetches that user's GitHub profile → stores it in RDS → exposes list/detail query APIs. Frontend lets users do this from a UI.

The user is **learning AWS hands-on**: they perform the AWS console / CLI operations themselves; Claude writes application code and explains concepts. Diagrams in `notes/*.svg` are rendered to `.png` with `rsvg-convert -z 2`.

## The playground project — architecture

Full-stack, all in region **ap-southeast-1**, deployed via CI/CD:

```
Frontend (better-t-stack) → S3 + CloudFront
Browser → API Gateway (HTTP API, CORS) → Lambda (Node.js) → GitHub API + RDS MySQL
Merge to main → GitHub Actions (OIDC) → auto-deploy both
```

- **Backend** (`playground/backend/`, npm): `handler.js` is the Lambda entry. It routes by `event.routeKey` (API Gateway HTTP API payload v2: `"POST /profiles"`, `"GET /profiles"`, `"GET /profiles/{id}"`). `mapper.js` is pure logic (GitHub JSON → DB row) and is the unit-tested part. DB access via `mysql2` using `DB_*` env vars. **The GitHub token is used to fetch then discarded — never stored, never logged.** Dedup on `github_id` via `INSERT ... ON DUPLICATE KEY UPDATE`.
- **Frontend** (`playground/frontend/`, **pnpm turborepo**): the actual app is `apps/web` (TanStack Router + Vite + React). `apps/fumadocs` is an unused scaffold extra. API base comes from `VITE_API_URL` (in `apps/web/.env`, gitignored; injected in CI). API client: `apps/web/src/lib/api.ts`. Routes are file-based in `apps/web/src/routes/`. The "Neon Protocol" cyberpunk theme uses Tailwind v4 tokens prefixed `np-` defined in `apps/web/src/index.css` (kept separate from the shadcn theme in the `@my-better-t-app/ui` package).

## Commands

Backend (`playground/backend/`):
```bash
node --test                 # run mapper unit tests
npm ci --omit=dev           # install prod deps (mysql2) before packaging
```

Frontend (`playground/frontend/`):
```bash
pnpm install                # install (pnpm 11; see allowBuilds gotcha below)
pnpm -F web dev             # local dev server → http://localhost:3001
pnpm -F web build           # build apps/web → apps/web/dist
pnpm dlx ultracite check apps/web/src   # lint
pnpm dlx ultracite fix apps/web/src     # auto-fix lint/format
```

Deploy is automatic on merge to `main` (see CI/CD). Manual deploy commands are in `playground/README.md`.

## CI/CD & git (non-obvious)

- **Git root is `aws-learning/`, not `playground/`.** The workflow lives at `.github/workflows/deploy.yml` (repo root) and references `playground/backend/**` and `playground/frontend/**`. It triggers only on `push` to `main` touching those paths or the workflow itself.
- Two jobs run in parallel: **backend** (npm install → zip `handler.js mapper.js node_modules package.json` → `aws lambda update-function-code`) and **frontend** (pnpm build `apps/web` with `VITE_API_URL` from workflow env → `aws s3 sync apps/web/dist` → CloudFront invalidation).
- Auth is **GitHub OIDC** (no stored AWS keys): the workflow assumes IAM role `github-actions-deploy`, trusted only for `repo:Adophlidu/aws-learning:ref:refs/heads/main`.
- The repo is pushed via a dedicated SSH host alias `github-adophlidu` (user has two GitHub accounts; this repo uses the `Adophlidu` account). Normal `git push` works because `origin` already uses that alias.

## Gotchas

- **pnpm `allowBuilds`**: `playground/frontend/pnpm-workspace.yaml` must have `esbuild: true` under `allowBuilds:` (better-t-stack ships a `set this to true or false` placeholder). Without it, `pnpm -F web build` fails because esbuild's build script is blocked. pnpm 11 ignores `pnpm.onlyBuiltDependencies` in package.json — config goes in `pnpm-workspace.yaml`.
- When editing frontend code, follow the **Ultracite/Biome** standards — see `playground/frontend/.claude/CLAUDE.md`. TanStack route files (`routes/**`, e.g. `profiles.$id.tsx`) are exempted from `useFilenamingConvention` via a `biome.json` override.
- `notes/` and `docs/` are committed; the `playground/README.md` holds the live URLs, full AWS resource inventory (RDS `profile-db`, Lambda `profile-api`, S3 `profile-frontend-dudu0506`, CloudFront `E3BVT93IFZLACO`), and a cost runbook. **RDS is always-on (free-tier hours) — stop it when idle.**

## Security note (learning tradeoff)

This is a learning project, so the RDS is **publicly accessible** (security group open on 3306) to keep Lambda outside the VPC (so it can reach the GitHub API without a NAT). This is deliberately NOT production-grade — `playground/docs/` and the design doc document the production alternatives (private RDS + Lambda-in-VPC + NAT, RDS Data API, or split Lambdas).
