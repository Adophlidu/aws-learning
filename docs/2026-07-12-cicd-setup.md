# CI/CD 上手 Runbook（Phase 5）

> 配合 `specs/2026-07-12-phase5-cicd-plan.md`。本文档是**你在 GitHub / AWS 控制台要做的手动步骤**清单——代码（workflows + Terraform）已写好，这里是把它跑起来的开关。

## 全景

```
feature ─PR─► main ──push──► deploy-test.yml ─► _deploy.yml (environment: test) ──► test 环境
                     发版时                                                        自动，无需审批
main ──merge──► production ─push─► deploy-prod.yml ─► _deploy.yml (environment: prod)
                                                       └─ required reviewers 卡审批 ─► prod 环境

PR ──► pr-preview.yml：前端传 test 桶 pr-N/ 前缀 + 评论 URL；infra 改动跑 terraform validate
```

- **App 部署（services/bff/frontend）** 全自动化，走 OIDC 免密钥。
- **基础设施（Terraform）仍由你手动 `apply`**（学习约定）；CI 只在 PR 上 `validate`，不 apply。

---

## 一次性设置（按顺序）

### 1. 建 `production` 分支
```bash
git checkout main && git pull
git checkout -b production && git push -u origin production
git checkout main
```

### 2. 手动 apply 基础设施（两个环境各一次）
> 这一步创建 VPC/RDS/ECR/ALB/ECS 空服务/BFF/前端 S3+CloudFront/部署角色。首次 ECS 服务会因没镜像而起不来——正常，等第一次 CI 推镜像后自愈；或先手推一次 `:latest`。

```bash
cd infra
terraform workspace select test || terraform workspace new test
terraform apply            # 记下 outputs

terraform workspace select prod || terraform workspace new prod
terraform apply            # 记下 outputs
```

### 3. 建 GitHub Environments 并填 Variables
仓库 → Settings → Environments，建 **`test`** 和 **`prod`** 两个环境。

**prod 环境**：勾选 **Required reviewers**，加你自己 → 这就是「生产强制人工审批」。test 不加。

给**每个**环境填以下 **Variables**（Settings → Environments → <env> → Environment variables），值取自对应 workspace 的 `terraform output`：

| 变量 | 取值命令 |
|---|---|
| `NAME_PREFIX` | 固定：test 填 `profile-test`，prod 填 `profile-prod` |
| `AWS_ACCOUNT_ID` | 固定 `930698106220` |
| `DEPLOY_ROLE_ARN` | `terraform output -raw deploy_role_arn` |
| `VITE_API_URL` | `terraform output -raw bff_api_url` |
| `FRONTEND_BUCKET` | `terraform output -raw frontend_bucket` |
| `CLOUDFRONT_ID` | `terraform output -raw cloudfront_id` |
| `FRONTEND_URL` | `terraform output -raw cloudfront_domain` |

> 注意 `terraform output` 前先 `terraform workspace select <env>`，别把 test 的值填进 prod。

### 4. 完成
push 到 `main` 即触发 test 部署；merge 到 `production` 触发 prod（审批后）部署。

---

## 关键设计说明

- **OIDC 信任按环境隔离**：`test` 角色只信 `environment:test` / `main` / `pull_request`；`prod` 角色只信 `environment:prod` / `production`。即便工作流写错，prod 角色也拒签 test 的 token（见 `infra/iam.tf` 的 `local.allowed_subs`）。
- **路径分流**：`dorny/paths-filter` 只部署实际改动的块——只改前端不会重推镜像。
- **滚动更新**：Go 服务 `docker push :latest`+`:${sha}` 后 `aws ecs update-service --force-new-deployment`，ECS 拉新 `:latest` 滚动替换。
- **前端私有化**：S3 桶不开公网，只有 CloudFront 经 OAC 签名可读；SPA 404/403 回退 `index.html`。

## 已知限制 / 取舍

- **PR 预览深链**：`/pr-N/` 下用 `vite --base` 保证静态资源加载，但 TanStack Router 的 basepath 未注入 → 落地页可预览、客户端深链是已知限制（符合设计 §7「纯前端预览」定位）。含后端改动的 PR，其后端要合入 test 才能联调。
- **CI 不管 infra**：本地 state，无远程后端 → Terraform 由你手动 apply。若日后要 CI 托管 infra，需迁 S3 backend + DynamoDB 锁，再加一个受审批保护的 `terraform apply` job。
- **DB 迁移**：当前建表靠服务启动时幂等 `CREATE TABLE IF NOT EXISTS`，对本学习项目足够。**生产路径**：引入 `golang-migrate`，迁移文件放 `services/*/migrations/`，部署时以 ECS 一次性任务对目标库跑，遵守 **expand/contract**（先加列→部署新代码→下个版本再删旧列），生产迁移前先 RDS 快照并走审批。

## 成本提醒
两套环境（test+prod）同时开 = 双份 NAT/RDS/ALB/Fargate。学习验证时**只开一套**，验证完 `terraform destroy`。别把 prod 长期挂着。
