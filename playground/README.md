# GitHub Profile Collector

全栈练习项目：提交 GitHub token，抓取并存储 GitHub profile，提供查询接口。

- **前端**：better-t-stack (TanStack Router + Vite, "Neon Protocol" 主题) → S3 + CloudFront
- **后端**：API Gateway (HTTP) + Lambda(Node.js) + RDS MySQL
- **CI/CD**：GitHub Actions (OIDC)，合并 main 自动部署前后端

设计与计划见 `docs/` 与 `specs/`。

## 线上地址

- 前端：https://d9jr9zgy4z1k5.cloudfront.net
- API：https://0p7niszs4b.execute-api.ap-southeast-1.amazonaws.com
  - `POST /profiles` 提交 token 抓取入库 ｜ `GET /profiles` 列表 ｜ `GET /profiles/{id}` 详情

## AWS 资源（区域 ap-southeast-1）

| 资源 | 名称/ID |
|------|---------|
| RDS MySQL | `profile-db`（库 `profiles_app`，表 `profiles`） |
| Lambda | `profile-api`（Node.js 22，Handler `handler.handler`） |
| API Gateway | `profile-http-api` |
| S3 桶 | `profile-frontend-dudu0506` |
| CloudFront | 域名 `d9jr9zgy4z1k5.cloudfront.net`，ID `E3BVT93IFZLACO` |
| 部署角色 | `github-actions-deploy`（OIDC，限 main 分支） |

## 目录结构

```
playground/
├── backend/        Lambda 代码 (handler.js, mapper.js)
├── frontend/       better-t-stack monorepo（应用在 apps/web）
├── docs/           设计文档
└── specs/          实现计划
.github/workflows/deploy.yml   自动部署（仓库根在 aws-learning）
```

## 日常开发流程

改完代码 → 合并到 `main` → GitHub Actions 自动部署。无需手动操作。

## 本地手动操作（备用）

后端打包并更新 Lambda：
```bash
cd backend
npm ci --omit=dev
zip -r function.zip handler.js mapper.js node_modules package.json
aws lambda update-function-code --function-name profile-api --zip-file fileb://function.zip
```

前端构建并部署：
```bash
cd frontend
pnpm install
pnpm -F web build
aws s3 sync apps/web/dist s3://profile-frontend-dudu0506 --delete
aws cloudfront create-invalidation --distribution-id E3BVT93IFZLACO --paths "/*"
```

前端本地预览：`cd frontend && pnpm -F web dev` → http://localhost:3001

## 💰 成本控制（重要）

- **RDS 是常开型计费**：免费套餐每月 750 小时（前 12 个月）。**不用时建议停掉**：
  - RDS 控制台 → `profile-db` → Actions → **Stop**（最多停 7 天会自动重启；endpoint 不变）
  - 彻底不用了就 **Delete**（需重新建表才能恢复）
- Lambda / API Gateway / S3 / CloudFront 闲置基本免费（按用量，量小≈0）。
- 已配 **AWS Budgets 1 美元告警**兜底。

## 安全说明（学习版 vs 生产版）

| 方面 | 本项目（学习） | 生产做法 |
|------|----------------|----------|
| RDS 网络 | 公开访问 + 安全组 `0.0.0.0/0:3306` | 私有子网 + Lambda 进 VPC + RDS Proxy |
| API 鉴权 | Open（无鉴权） | API Key / Cognito / JWT |
| GitHub token | 用完即弃，不入库/不记日志 ✅ | 同样 |
| 部署凭证 | OIDC 临时凭证 ✅ | 同样 |
