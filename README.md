# GitHub Profile Collector

全栈 AWS 架构练习项目：提交 GitHub token → 抓取并存储 GitHub profile 与仓库统计 → 提供档案/语言统计/仓库/排行榜/搜索接口与页面。

**首要目的是练架构**：把最初「API Gateway + Lambda(Node) 直连公网 RDS」的单体，演进为 **Lambda BFF + 两个 Go 微服务 + 内网 ALB + Cloud Map 服务发现 + 私网 RDS**，全套 Terraform 管理、双环境 CI/CD。

> 完整设计见 [`docs/2026-07-12-architecture-overhaul-design.md`](docs/2026-07-12-architecture-overhaul-design.md)；分阶段实现计划见 [`specs/`](specs/)；CI/CD 上手见 [`docs/2026-07-12-cicd-setup.md`](docs/2026-07-12-cicd-setup.md)。

## 架构总览

```
                         Internet
   浏览器 ─► CloudFront ─► S3(前端, 私有 + OAC)
             │ /api/*      CloudFront Function 处理 SPA 子路径路由
             ▼
        API Gateway(HTTP) ─► Lambda BFF ─┐  (私网子网, 只调内网, 免 NAT)
                                          │  纯编排/聚合: 不碰 GitHub、不碰 DB
   ┌═══════════════════════ VPC (私网, 跨 2 AZ) ═══════════════│════════┐
   ║                                内网 ALB(internal) ◄────────┘        ║
   ║                                 │ 按路径路由 2 个目标组               ║
   ║              ┌──────────────────┴──────────────────┐               ║
   ║              ▼                                      ▼               ║
   ║      profile-service(Go/Fargate)          stats-service(Go/Fargate) ║
   ║      拥有 profiles 表                       拥有 repos 表            ║
   ║      抓 GitHub /user、搜索、详情            抓 /user/repos、统计、榜单 ║
   ║              ▲                                      │               ║
   ║              └──── Cloud Map(东西向: 取展示信息) ─────┘               ║
   ║      ┌──────────── RDS MySQL(私网, 无公网) ────────────┐            ║
   ║      └──────────────────────────────────────────────┘            ║
   ║   NAT Gateway ◄── 两个 Go 服务出网抓 GitHub                          ║
   ╚═════════════════════════════════════════════════════════════════════╝
   ECR: profile-service 镜像 + stats-service 镜像（2 个仓库）
```

**关键取舍：**

| 组件 | 职责 | 取舍 |
|------|------|------|
| **Lambda BFF**(Node) | 对外 API、编排聚合，**不碰 GitHub/DB** | 只调内网 ALB → 免 NAT，满足「Lambda 在私网」且省钱 |
| **profile-service**(Go) | `profiles` 表；抓 `/user`；搜索/详情 | 自己抓 GitHub → 需 NAT |
| **stats-service**(Go) | `repos` 表；抓 `/user/repos` 算语言统计/榜单 | 展示信息经 **Cloud Map** 调 profile-service，不跨表 JOIN |
| **内网 ALB** | 南北向：BFF → 服务，按路径分流 | 与 Cloud Map 分工：ALB 管入口，Cloud Map 管服务间 |
| **Cloud Map** | 东西向：stats → profile（`profile.svc.internal`） | 演示服务发现两种被发现方式 |
| **RDS** | 一个 MySQL，各服务只碰自己的表 | 跨域数据走服务调用 → 干净的微服务边界 |

## 功能

- **档案**：`POST /profiles`(抓取入库) ｜ `GET /profiles`(列表) ｜ `GET /profiles/{id}`(详情)
- **语言统计**：`GET /stats/{gid}`（按语言聚合 star/仓库数）
- **仓库**：`GET /repos/{gid}`（按 star 排序）
- **排行榜**：`GET /leaderboard?by=stars|repos`（top 10，展示信息经 Cloud Map 补全）
- 前端页面：首页/详情（语言分布+仓库表）/排行榜/搜索，全中文，赛博朋克「Neon Protocol」主题

## 目录结构

```
playground/                      （git submodule → Adophlidu/aws-learning）
├── bff/                 Lambda BFF (Node.js) —— 纯编排
├── services/
│   ├── profile-service/ Go：profiles，抓 /user，搜索/详情
│   └── stats-service/   Go：repos，抓 /user/repos，语言统计/榜单
├── frontend/            better-t-stack monorepo（应用在 apps/web）
├── infra/               Terraform（VPC/RDS/ECR/ALB/CloudMap/ECS/S3+CF/OIDC）
├── backend/             旧 Node Lambda（已被 bff+services 取代，保留作参考）
├── docs/                设计文档 + CI/CD runbook
└── specs/               分阶段实现计划（phase1~5）
.github/workflows/       deploy-test / deploy-prod / _deploy / pr-preview
```

## 基础设施（Terraform）

- **VPC** `10.0.0.0/16` 跨 2 AZ：公网子网(NAT+IGW) + 私网子网(Lambda ENI/内网 ALB/Fargate×2/RDS)。
- **workspace 管环境**：`test` / `prod` 各一套，`name_prefix = profile-${workspace}`。
- **前端托管**：私有 S3 + CloudFront(OAC) + CloudFront Function(SPA 子路径路由)。
- **密钥**：DB 密码进 Secrets Manager，容器启动注入；GitHub token 不存。
- **VPC 端点**：只加免费的 S3 网关端点；ECR/日志/Secrets 走 NAT（学完即拆，不值接口端点月租）。

> **基础设施由人手动 `terraform apply`**（学习约定）；CI 只在 PR 上 `terraform validate`，不 apply。

## CI/CD（双环境）

```
feature ─PR─► main ──合并──► deploy-test.yml ─► test 环境（自动）
                     发版时合并 main → production
production ──push──► deploy-prod.yml ─► 【GitHub Environment 强制人工审批】─► prod 环境
```

- **按路径分流**（`dorny/paths-filter`）：只部署改动的那块（services / bff / frontend）。
- **Go 服务**：docker build → 推 ECR(`:latest`+`:sha`) → `ecs update-service --force-new-deployment` 滚动更新。
- **BFF**：zip → 更新 Lambda。**前端**：build → S3 sync → CloudFront 失效。
- **PR 预览（纯前端）**：构建到 S3 `pr-N/` 前缀，评论预览 URL（指向共享 test 后端）；PR 关闭自动清理。
- **免密钥**：GitHub OIDC assume 每环境独立 IAM 角色，信任按 workspace 隔离。
- **手动开关**：`deploy-test`/`deploy-prod` 支持 `workflow_dispatch` 全量部署（首次 bootstrap / 强制重部署）。

详细上手步骤（建分支、apply、配 GitHub Environments/Variables）见 [`docs/2026-07-12-cicd-setup.md`](docs/2026-07-12-cicd-setup.md)。

## 本地开发

```bash
# 前端
cd frontend && pnpm install
pnpm -F web dev          # http://localhost:3001
pnpm -F web build        # 构建
pnpm dlx ultracite check apps/web/src   # lint

# Go 服务（各自目录）
cd services/profile-service && go test ./... && go build .
docker compose up        # 本地起服务 + MySQL

# 基础设施
cd infra && terraform fmt && terraform validate
```

## 💰 成本控制（重要）

这套架构的大头是 **NAT Gateway + RDS + ALB + Fargate**，都是按小时计费：

- **学完即拆**：`cd infra && terraform workspace select test && terraform destroy`。
- 验证时**只开一套环境**（别 test/prod 同时挂着 = 双份费用）。
- 已配 **AWS Budgets 1 美元告警**兜底。

## 安全说明（学习版已接近生产）

| 方面 | 本项目 | 说明 |
|------|--------|------|
| RDS 网络 | 私有子网，无公网 ✅ | 各服务经安全组链最小权限访问 |
| Lambda | 进 VPC 私网子网 ✅ | 只调内网 ALB，免 NAT |
| 服务间调用 | Cloud Map 私有 DNS ✅ | 东西向不经公网 |
| 前端桶 | 私有 + CloudFront OAC ✅ | 不对公网开放，仅 CloudFront 签名可读 |
| API 鉴权 | Open（无鉴权） | 学习取舍；生产用 API Key / Cognito / JWT |
| GitHub token | 用完即弃，不入库/不记日志 ✅ | 仅透传给 Go 服务抓取 |
| 部署凭证 | OIDC 临时凭证 ✅ | 无长期 AK/SK |
| DB 迁移 | 服务启动幂等 DDL | 生产路径：golang-migrate + expand/contract（见 runbook） |
