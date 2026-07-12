# Phase 5：CI/CD 完整化实施计划

> 对应设计文档 `docs/2026-07-12-architecture-overhaul-design.md` §7。收官阶段：双分支多环境 + prod 审批 + 路径触发 + PR 前端预览。

**Goal:** 把新架构（bff + 两个 Go 服务 + 前端）接上 GitHub Actions CI/CD——`main`→test 自动部署、`production`→prod 强制人工审批、按路径分流、PR 前端预览。

**Architecture:** GitHub OIDC 免密钥 assume 每环境独立 IAM 角色；一个可复用工作流 `_deploy.yml`（workflow_call）被 `deploy-test`/`deploy-prod` 调用；`dorny/paths-filter` 按 `services/`·`bff/`·`frontend/` 分流；前端托管新增进 Terraform（S3+CloudFront+OAC，按 workspace 分环境）。

**Tech Stack:** GitHub Actions（reusable workflow、matrix、environments）、Terraform（S3/CloudFront/IAM OIDC）、Docker buildx、aws-cli。

## Global Constraints（本 Plan 铁律）

- **Terraform 由用户手动 apply**（学习约定）→ CI **不做 `terraform apply`**；仅在 PR 上跑 `terraform fmt -check` + `validate` 作校验门。
- App 部署（services/bff/frontend）是对**已存在基础设施**的幂等推送，交给 CI/CD。
- 免密钥：一律 GitHub OIDC assume IAM 角色，不存 AWS AK/SK。
- prod 审批靠 **GitHub Environments required reviewers**（用户在 GitHub 控制台配），不是 IAM。
- 建表沿用**服务启动时幂等 DDL**（`CREATE TABLE IF NOT EXISTS`）；golang-migrate 只在 runbook 里作为生产路径说明，不进 CI。
- 资源命名（已定，`name_prefix = profile-${workspace}`）：
  - ECR：`${prefix}-profile-service` / `${prefix}-stats-service`
  - ECS 集群：`${prefix}-cluster`；服务：`${prefix}-profile` / `${prefix}-stats`
  - Lambda：`${prefix}-bff`；API URL：terraform output `bff_api_url`

## 环境变量契约（用户 apply 后从 `terraform output` 填到 GitHub Environment）

每个 GitHub Environment（`test` / `prod`）设以下 **Variables**（非 secret，无敏感）：

| 变量 | 来源 | 例 |
|---|---|---|
| `NAME_PREFIX` | 约定 | `profile-test` / `profile-prod` |
| `AWS_ACCOUNT_ID` | 账号 | `930698106220` |
| `DEPLOY_ROLE_ARN` | `terraform output deploy_role_arn` | `arn:aws:iam::...:role/profile-test-gha-deploy` |
| `VITE_API_URL` | `terraform output bff_api_url` | `https://xxx.execute-api...` |
| `FRONTEND_BUCKET` | `terraform output frontend_bucket` | `profile-test-frontend-930698106220` |
| `CLOUDFRONT_ID` | `terraform output cloudfront_id` | `E...` |
| `FRONTEND_URL` | `terraform output cloudfront_domain` | `https://d123.cloudfront.net` |

> 区域固定 `ap-southeast-1`（写死在工作流）。其余资源名由 `NAME_PREFIX`+`AWS_ACCOUNT_ID` 拼出，无需再设。

---

## Task 1：`infra/frontend.tf` —— S3 + CloudFront + OAC

**Files:** Create `infra/frontend.tf`；Modify `infra/outputs.tf`（加 3 个输出）

- 私有 S3 桶 `${prefix}-frontend-${account_id}`，`force_destroy=true`（学习）。
- CloudFront + Origin Access Control（OAC）签名访问私有桶；`default_root_object=index.html`。
- SPA fallback：403/404 → `/index.html`（200）。
- 桶策略只允许该 CloudFront distribution 读。
- 输出 `frontend_bucket` / `cloudfront_id` / `cloudfront_domain`。

- [ ] Step 1：写 `frontend.tf`（bucket + public_access_block + OAC + distribution + bucket_policy）
- [ ] Step 2：加 outputs
- [ ] Step 3：`terraform validate` 通过

## Task 2：`infra/iam.tf` —— per-env 信任 + S3/CloudFront 权限

**Files:** Modify `infra/iam.tf`

- 信任按 workspace 收紧（不再 `sub=repo:*`）：
  - prod 角色只信 `environment:prod` + `ref:refs/heads/production`
  - test 角色只信 `environment:test` + `ref:refs/heads/main` + `pull_request`
- 部署策略补：`s3:PutObject/DeleteObject/ListBucket/GetObject`（限 `arn:aws:s3:::profile-*-frontend-*`）+ `cloudfront:CreateInvalidation`。

- [ ] Step 1：改 assume_role_policy 的 condition 为 workspace 三元
- [ ] Step 2：policy 加 S3 + CloudFront 语句
- [ ] Step 3：`terraform validate` 通过

## Task 3：`_deploy.yml` —— 可复用部署工作流

**Files:** Create `.github/workflows/_deploy.yml`

- `on: workflow_call`，inputs：`environment`、`deploy_services`、`deploy_bff`、`deploy_frontend`（boolean）。
- `permissions: {id-token: write, contents: read}`。
- **services** job：`if inputs.deploy_services`，`environment: ${{ inputs.environment }}`，matrix `[profile, stats]`；OIDC assume `vars.DEPLOY_ROLE_ARN` → ECR login → `docker build --platform linux/amd64` `services/${svc}-service` 打 `:latest`+`:${sha}` 推送 → `aws ecs update-service --force-new-deployment`。
- **bff** job：zip `bff/` → `aws lambda update-function-code`。
- **frontend** job：pnpm build（`VITE_API_URL=${{ vars.VITE_API_URL }}`）→ `aws s3 sync --delete` → CloudFront 失效。
- 三个 job 都 `environment: ${{ inputs.environment }}`（触发环境保护 + 读该环境 vars）。

- [ ] Step 1：写 `_deploy.yml`
- [ ] Step 2：Python YAML 解析无语法错误

## Task 4：`deploy-test.yml` / `deploy-prod.yml` —— 触发器

**Files:** Create `.github/workflows/deploy-test.yml`、`.github/workflows/deploy-prod.yml`

- 各含 `changes` job（`dorny/paths-filter@v3` 输出 services/bff/frontend 布尔）+ `deploy` job（`uses: ./.github/workflows/_deploy.yml`，`secrets: inherit`）。
- test：`on push branches[main]`，`environment: test`。
- prod：`on push branches[production]`，`environment: prod`（其 required reviewers 卡审批）。

- [ ] Step 1：写两个触发工作流
- [ ] Step 2：YAML 解析通过

## Task 5：`pr-preview.yml` —— 前端预览 + infra 校验 + 清理

**Files:** Create `.github/workflows/pr-preview.yml`

- `on pull_request types [opened, synchronize, reopened, closed]`。
- `changes`（frontend/infra 布尔）。
- **preview**（frontend 变更且非 closed，`environment: test`）：`pnpm -F web build -- --base=/pr-${N}/` → `aws s3 sync dist s3://$BUCKET/pr-${N}/` → `gh pr comment` 贴 `${FRONTEND_URL}/pr-${N}/index.html`。
- **infra-check**（infra 变更且非 closed，无凭证）：`terraform init -backend=false` + `fmt -check` + `validate`。
- **cleanup**（closed，`environment: test`）：`aws s3 rm --recursive s3://$BUCKET/pr-${N}/`。

> 权衡（写进 runbook）：SPA 在 `/pr-N/` 前缀下资源用 `--base` 可加载，但客户端深链路由 basepath 未注入——落地页可预览，深链是已知限制，符合设计 §7「纯前端预览」定位。

- [ ] Step 1：写 `pr-preview.yml`
- [ ] Step 2：YAML 解析通过

## Task 6：runbook + 退役旧 workflow + 校验提交

**Files:** Create `docs/2026-07-12-cicd-setup.md`；Delete `.github/workflows/deploy.yml`

- runbook：创建 `production` 分支、GitHub Environments（test/prod）+ prod required reviewers、逐条 vars 填写、手动 terraform apply 顺序、PR 预览限制说明、golang-migrate 生产路径备注。
- 删旧 `deploy.yml`（被新工作流取代；旧 `backend/` Node 保留作参考，不再部署）。
- 全量校验：`terraform fmt`、`terraform validate`；Python 解析 5 个 workflow YAML。

- [ ] Step 1：写 runbook
- [ ] Step 2：删 `deploy.yml`
- [ ] Step 3：`terraform validate` + YAML 解析全过
- [ ] Step 4：本地提交（不 push——同 Plan 4，交由用户择时）

---

## 验证策略（全本地）

1. `terraform fmt && terraform validate`（frontend.tf / iam.tf 语法与引用）。
2. Python `yaml.safe_load` 逐个解析 workflow，确认无语法错误。
3. 人工审查：OIDC sub 条件、vars 引用名、资源名拼接、job 依赖。
4. **不触发真实部署**：需用户先 apply 基础设施 + 配 GitHub Environments/vars/分支后，push 才生效。

## 风险

- **本地 state**：CI 不跑 terraform（无远程后端）；基础设施由用户手动 apply，CI 只 validate。若日后要 CI 管 infra，需迁 S3 backend。
- **PR 预览 basepath**：见上，深链限制。
- **prod 误部署**：靠 GitHub Environment required reviewers 兜底；IAM 信任也按 workspace 隔离（test 角色不信 prod 环境）。
- **首次 ECS 部署**：`update-service --force-new-deployment` 要求服务已由 terraform 建好（desired_count=1）；镜像 `:latest` 已存在才能起。顺序：terraform apply（建空服务+首镜像）→ 之后 CI 滚动更新。
