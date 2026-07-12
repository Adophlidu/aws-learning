# GitHub Profile Collector 架构改造设计（v2）

> 设计文档 ｜ 2026-07-12
> 目标：把当前「API Gateway + Lambda(Node) + RDS」的单体演进为 **Lambda BFF + 两个 Go 微服务 + 内网 ALB + Cloud Map + 私网 RDS**，全套用 Terraform 管理、CI/CD 双环境，作为**已学 AWS 架构知识点的综合实操**。

---

## 1. 背景与目标

**现状**：`POST /profiles`(抓 GitHub profile 存库) + `GET /profiles`(列表) + `GET /profiles/{id}`(详情)，Lambda(Node) 直连公开 RDS。功能单一、RDS 公网暴露（学习妥协）。

**目标**：应用「骨架 C（Lambda BFF + 领域服务 + RDS）」+ 容器（ECS/ECR/Fargate）+ 服务发现（Cloud Map）+ 私网化 + IaC + 多环境 CI/CD。**首要目的是练架构**，功能只需"配得上这套架构"。

**非目标 / YAGNI（明确不做）**：
- 不加 Redis 缓存（榜单用 SQL 聚合即可）。
- 不做后台定时刷新（EventBridge worker）。
- PR 预览**不做全栈**，只前端预览指向共享测试后端。
- 不追求长期常驻，**学完即 `terraform destroy`**。

---

## 2. 功能范围（给 Go 服务"真活干"）

在原有 profile CRUD 基础上新增三块，交给 Go 领域服务：
1. **仓库 + 语言统计**：抓用户 repos，聚合语言分布 / star 总数 / 活跃度。
2. **排行榜**：对已收集的所有 profile 按 followers / repos / stars 排名。
3. **搜索 / 筛选**：按语言 / 地区 / 关注数筛选 profile。

---

## 3. 架构与职责

```
                          Internet
   浏览器 ─► CloudFront ─► S3(前端, 私有+OAC)     ← 新增: 仓库/语言统计/榜单/搜索 页面
             │ /api/*
             ▼
        API Gateway(HTTP) ─► Lambda BFF ─┐  (私网子网, 只调内网, 免 NAT)
                                          │  纯编排/聚合: 不碰 GitHub、不碰 DB
   ┌═══════════════════════ VPC (私网, 跨2 AZ) ════════════════│════════┐
   ║                                内网 ALB(internal) ◄────────┘        ║
   ║                                 │ 按路径路由 2 个目标组               ║
   ║              ┌──────────────────┴──────────────────┐               ║
   ║              ▼                                      ▼               ║
   ║      profile-service(Go/Fargate)          stats-service(Go/Fargate) ║
   ║      拥有 profiles 表                       拥有 repos/language_stats ║
   ║      抓 GitHub /user、搜索、详情            抓 /user/repos、语言统计、榜单
   ║              ▲                                      │               ║
   ║              └──── Cloud Map(东西向: 取展示信息) ─────┘               ║
   ║      ┌──────────── RDS MySQL(私网, 无公网) ────────────┐            ║
   ║      │ profiles │ repos │ language_stats               │            ║
   ║      └──────────────────────────────────────────────┘            ║
   ║   NAT Gateway ◄── 两个 Go 服务出网抓 GitHub                          ║
   ║   S3 网关端点(免费, ECR 层拉取)；ECR/日志/Secrets 走 NAT              ║
   ╚═════════════════════════════════════════════════════════════════════╝
   ECR: profile-service 镜像 + stats-service 镜像（2 个仓库）
```

**职责划分（关键取舍）：**

| 组件 | 职责 | 取舍理由 |
|------|------|---------|
| **Lambda BFF**(Node) | 对外 API、编排、聚合多服务响应。**不碰 GitHub、不碰 DB** | 只调内网 ALB → **免 NAT**；满足"lambda 在私网"且省钱 |
| **profile-service**(Go) | 拥有 `profiles`；抓 GitHub `/user` 入库；搜索/详情 | 自己抓 GitHub → 需 NAT + 拿 token |
| **stats-service**(Go) | 拥有 `repos`/`language_stats`；抓 `/user/repos` 算语言统计；算榜单 | 算榜单要 profile 展示信息 → **经 Cloud Map 调 profile-service**，不跨表 JOIN |
| **RDS** | 一个 MySQL 实例，**各服务只碰自己的表** | 跨域数据走服务调用 → 干净的微服务边界 |
| **Cloud Map** | 私有命名空间 `svc.internal`；profile-service **同时**注册到 ALB 目标组(南北向)+Cloud Map(东西向) | 一个服务两种被发现方式，演示两者 |

> **为什么 Lambda 必须进 VPC**：要调**内网 ALB**（私有）。而 Lambda 进 VPC 只能放私网子网（其 ENI 无公网 IP，放公网子网也上不了网）。因只做内网调用，故免 NAT。

---

## 4. 数据流（5 条主要路径）

```
① 提交/刷新  POST /profiles {token}
   Lambda BFF ─► profile-service: 抓/user → upsert profiles → 返回 {id, login}
              └► stats-service:  抓/user/repos → 算语言统计 → upsert repos/language_stats
   BFF 聚合 → 201 {profile, stats 摘要}

② 搜索      GET /profiles?lang=Go&location=CN&minFollowers=100
   Lambda BFF ─► profile-service 查询 → 列表

③ 详情+统计  GET /profiles/{id}
   Lambda BFF ─► profile-service(profile) + stats-service(该用户语言统计) → 聚合

④ 仓库      GET /profiles/{id}/repos
   Lambda BFF ─► stats-service → 仓库列表

⑤ 榜单      GET /leaderboard?by=followers|repos|stars
   Lambda BFF ─► stats-service 作为"榜单聚合器"
              ├ by=stars  → 用自己的 language_stats（star_sum）排名
              └ by=followers|repos → 经 Cloud Map 调 profile-service 取各用户
                followers/repos + 展示信息(头像/昵称) → 聚合排名
              → 榜单
```

路径 ⑤ 是 Cloud Map 落地点：stats-service 作为聚合器，`by=stars` 用自有数据，`by=followers|repos` 及所有条目的展示信息都经 **Cloud Map 调 profile-service** 获取（不跨表 JOIN）。ALB 负责南北向（Lambda→服务），Cloud Map 负责东西向（stats→profile），两者都有不可替代职责。

**token 流转**：仅透传给两个 Go 服务用于抓取，用完即弃，**不入库、不记日志**。

---

## 5. 数据模型（RDS MySQL）

| 表 | 属主 | 关键字段 |
|----|------|---------|
| `profiles` | profile-service | github_id(唯一), login, name, avatar_url, bio, company, location, public_repos, followers, following, github_created_at |
| `repos` | stats-service | github_id(属主用户), repo_name, language, stargazers_count, updated_at |
| `language_stats` | stats-service | github_id, language, repo_count, star_sum（按用户聚合缓存） |

- 各服务只读写自己的表；跨域数据经服务调用。
- `github_id` 作为跨服务关联键（stats 用它对应 profile）。

---

## 6. 基础设施（Terraform）

**VPC**：`10.0.0.0/16`，跨 2 AZ。
- 公网子网 ×2：NAT Gateway(1 个) + IGW。
- 私网子网 ×2：Lambda ENI、内网 ALB、Fargate ×2、RDS。

**安全组链（最小权限）：**
```
Lambda-SG ─► ALB-SG ─► {profile-svc-SG, stats-svc-SG} ─► RDS-SG(3306)
                        stats-svc-SG ─► profile-svc-SG (Cloud Map 东西向直连)
```

**决策：**
| 项 | 方案 |
|----|------|
| NAT | 1 个 NAT Gateway（单 AZ，学习够用；生产每 AZ 一个） |
| VPC Endpoints | 只加 **S3 网关端点（免费）**；ECR/日志/Secrets 走 NAT（接口端点 ~$7/月×N 太贵，且学完即拆，不值） |
| 密钥 | DB 密码进 Secrets Manager；GitHub token 不存 |
| Terraform | 模块化 `network/ecr/rds/alb/ecs/lambda/cloudmap/cicd-iam`；**workspace 管 test/prod**；本地 state（或 S3 后端） |
| ECS | 1 集群，2 服务各 1 个 Fargate 任务（最小规格） |
| RDS | `db.t4g.micro`，私网子网组，无公网 |

**成本与拆除**：`terraform apply` 起全套 → 跑 CI/CD + 验证（几小时）→ `terraform destroy` 全拆。按小时计费，一次验证约几毛~几块。

---

## 7. CI/CD 与多环境

**仓库演进为 monorepo（`Adophlidu/aws-learning`）：**
```
bff/                 Lambda BFF (Node.js 保留, 非 ECR)
services/
  profile-service/   Go (ECR/Fargate)
  stats-service/     Go (ECR/Fargate)
frontend/            前端 (S3+CloudFront)
infra/               Terraform
.github/workflows/
```

**分支 → 环境：**
```
feature ─PR─► main ─合并─► 自动部署 test
                    发版时合并 main → production
production ─合并─► 【强制人工审批 (GitHub Environments required reviewers)】─► 部署 prod
```

**流水线（按路径变更独立触发）：**
| 改动 | 动作 |
|------|------|
| `services/*/` (Go) | docker build → push **ECR**(tag=git-sha) → 更新对应 **ECS 服务**(滚动) |
| `bff/` | zip → 更新 Lambda |
| `frontend/` | build → s3 sync → CloudFront 失效 |
| `infra/` | `terraform plan/apply`（prod 走审批门） |
| **DB 迁移** | Go 服务用 `golang-migrate`，部署时对目标环境库跑，守 **expand/contract**（先加列→部署→下版本再删） |

**PR 预览（前端 only）：**
```
on: pull_request  → build 前端 → 传 S3 前缀 pr-N/ → 评论预览 URL(指向 test API)
on: PR closed     → 清理 pr-N/ 前缀
```
- 权衡：纯前端 PR 完美；含后端改动的 PR 其后端要合入 test 才能验证（预览指向共享测试后端）。

**认证**：GitHub OIDC assume IAM role（免存密钥），沿用现有 `github-actions-deploy` 思路，按环境分角色/信任。

---

## 8. 实施阶段（供实现计划展开）

> **进度（截至 2026-07-12）**：✅ Plan 1 基础设施（specs/2026-07-12-phase1-infra-plan.md，已 apply/验证/destroy）｜✅ Plan 2 profile-service+BFF+APIGW 南北向（phase2 plan，端到端通电验证过）｜✅ Plan 3 stats-service+Cloud Map 东西向（phase3 plan，榜单跨服务验证过）｜✅ Plan 4 前端新页面（phase4 plan，语言统计/仓库/榜单/搜索，`pnpm -F web build` 通过，commit 68de66e）｜⬜ **下一步 Plan 5 CI/CD**（双分支/prod 审批/PR 前端预览/自动迁移）。
> 恢复执行：说"继续 Plan 5"即可；设计阶段 2+3 已合并进 Plan 2 实施。Plan 4 纯前端本地代码，未部署（真机联调随 Plan 5 上 S3+CloudFront）。

1. **基础设施基线（Terraform）**：network、私网 RDS、ECR×2、ALB、Cloud Map、ECS 集群、OIDC/IAM。
2. **profile-service(Go)**：把现有 profile CRUD + 搜索移植为 Go 服务，跑 Fargate、挂 ALB；RDS 私网化；Lambda 改为经 ALB 调它。
3. **Lambda BFF 重构**：从"直连 DB"改为"纯编排"，调 profile-service。
4. **stats-service(Go)**：repos + 语言统计 + 榜单；接 Cloud Map，实现 stats→profile 东西向调用。
5. **前端新页面**：仓库 / 语言统计 / 榜单 / 搜索。
6. **CI/CD 完整化**：双分支、prod 审批、PR 前端预览、自动迁移。

每阶段可独立部署、验证；阶段 1 是其余的地基。

---

## 9. 风险与注意

- **NAT 是最大成本点**：务必学完 `destroy`；或临时用 NAT 实例替代（本设计用 NAT Gateway 图省心）。
- **迁移安全**：滚动部署时新旧代码并存，schema 守 expand/contract，生产迁移前先快照、走审批。
- **契约错位**：PR 前端预览指向旧的测试后端，全栈改动体现不了——纯前端 PR 才完美。
- **单 NAT / 单任务是学习取舍**：非高可用，生产需跨 AZ 冗余。
- **submodule 工作流**：本仓库改动 push 到 `Adophlidu/aws-learning`（SSH 别名 `github-adophlidu`），brain 再更新 submodule 指针。
