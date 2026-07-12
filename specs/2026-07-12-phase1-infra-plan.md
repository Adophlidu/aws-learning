# 架构改造 Plan 1：基础设施基线（Terraform）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **学习项目说明**：这是「教练手册」——`terraform` 命令由用户亲手运行，Claude 写 `.tf` 代码并解释。每个任务：写代码 → `fmt/validate/plan`（免费、不建资源）→ 验证。**只有 Task 10 才真正 `apply` 建资源（花钱），验证完立即 `destroy`。**

**Goal:** 用 Terraform 把改造后架构所需的**基础设施基线**一键起/一键拆：VPC(私网+NAT)、私网 RDS、2×ECR、内网 ALB、Cloud Map、ECS 集群、CI/CD 用的 OIDC 角色——此阶段**只建"空架子"，不含应用代码/服务任务**（那是 Plan 2+）。

**Architecture:** 单 `infra/` 目录、**扁平 .tf 文件**（学习友好，不用嵌套 module）；Terraform **workspace** 区分 `test`/`prod`；跨 2 AZ；一个 NAT Gateway；RDS 私网无公网；ALB 为 internal；密码用 Secrets Manager。

**Tech Stack:** Terraform ≥1.6，AWS provider ≥5.0，region ap-southeast-1；资源：VPC/Subnet/IGW/NAT/RouteTable/VPCEndpoint、SecurityGroup、RDS MySQL、ECR、ServiceDiscovery(Cloud Map)、ELBv2(ALB)、ECS Cluster、IAM OIDC。

## Global Constraints

- 区域固定 **ap-southeast-1**，所有资源同区域。
- 命名统一前缀 `profile-${var.env}`（env 来自 workspace，如 `profile-test-vpc`）。
- **最小规格**：RDS `db.t4g.micro`、单 NAT、Fargate 任务留待 Plan 2。
- **学完即拆**：验证后必须 `terraform destroy`。
- 密码、tfvars 敏感值**不进 git**；DB 密码由 Terraform 生成并存 Secrets Manager。
- token 相关逻辑不在本阶段。
- 依据设计文档：`playground/docs/2026-07-12-architecture-overhaul-design.md`。
- 本仓库改动 push 到 `Adophlidu/aws-learning`（SSH 别名 `github-adophlidu`）；`infra/**` 不在部署 workflow 触发路径内，不会触发老的 deploy。

---

## 文件结构

```
playground/
└── infra/
    ├── versions.tf        # terraform 与 provider 版本
    ├── providers.tf       # aws provider (region)
    ├── variables.tf       # 输入变量（env、cidr、db 规格…）
    ├── locals.tf          # name_prefix、az 列表等派生值
    ├── network.tf         # VPC/子网/IGW/NAT/路由/S3端点
    ├── security.tf        # 5 个安全组 + 规则链
    ├── rds.tf             # 子网组 + MySQL + 随机密码 + Secrets Manager
    ├── ecr.tf             # 2 个镜像仓库
    ├── cloudmap.tf        # 私有 DNS 命名空间
    ├── alb.tf             # 内网 ALB + 2 目标组 + 监听器 + 路由规则
    ├── ecs.tf             # ECS 集群（空）
    ├── iam.tf             # GitHub OIDC provider + 部署角色
    ├── outputs.tf         # 关键输出
    ├── terraform.tfvars.example  # 变量示例（可提交）
    └── .gitignore         # 忽略 state / tfvars / .terraform
```

> 命名：所有资源用 `local.name_prefix`（=`profile-${terraform.workspace}`），故 `test`/`prod` workspace 天然隔离命名。

---

## Task 1: Terraform 骨架与初始化

**Files:**
- Create: `infra/versions.tf`, `infra/providers.tf`, `infra/variables.tf`, `infra/locals.tf`, `infra/terraform.tfvars.example`, `infra/.gitignore`

**目标**：建好 Terraform 工程骨架，`init` 成功，workspace 就绪。

- [ ] **Step 1: 写 `infra/versions.tf`**

```hcl
terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.5"
    }
  }
}
```

- [ ] **Step 2: 写 `infra/providers.tf`**

```hcl
provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = "github-profile-collector"
      ManagedBy = "terraform"
      Env       = terraform.workspace
    }
  }
}
```

- [ ] **Step 3: 写 `infra/variables.tf`**

```hcl
variable "region" {
  type    = string
  default = "ap-southeast-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "public_subnet_cidrs" {
  type    = list(string)
  default = ["10.0.0.0/24", "10.0.1.0/24"]
}

variable "private_subnet_cidrs" {
  type    = list(string)
  default = ["10.0.10.0/24", "10.0.11.0/24"]
}

variable "db_name" {
  type    = string
  default = "profiles_app"
}

variable "db_username" {
  type    = string
  default = "admin"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "github_repo" {
  type        = string
  description = "OWNER/REPO，用于 OIDC 信任"
  default     = "Adophlidu/aws-learning"
}
```

- [ ] **Step 4: 写 `infra/locals.tf`**

```hcl
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name_prefix = "profile-${terraform.workspace}"
  azs         = slice(data.aws_availability_zones.available.names, 0, 2)
}
```

- [ ] **Step 5: 写 `infra/terraform.tfvars.example` 与 `infra/.gitignore`**

`infra/terraform.tfvars.example`：
```hcl
# 复制为 terraform.tfvars 后按需覆盖默认值
# region = "ap-southeast-1"
# github_repo = "Adophlidu/aws-learning"
```

`infra/.gitignore`：
```
.terraform/
*.tfstate
*.tfstate.*
terraform.tfvars
.terraform.lock.hcl
```

- [ ] **Step 6: 初始化并建 workspace**

```bash
cd playground/infra
terraform init
terraform workspace new test   # 若已存在则: terraform workspace select test
terraform workspace show
```
Expected: `init` 成功下载 aws/random provider；`workspace show` 输出 `test`。

- [ ] **Step 7: 提交**

```bash
cd playground
git add infra/versions.tf infra/providers.tf infra/variables.tf infra/locals.tf infra/terraform.tfvars.example infra/.gitignore
git commit -m "infra: terraform skeleton (providers, variables, workspace)"
```

---

## Task 2: 网络（VPC / 子网 / IGW / NAT / 路由 / S3 端点）

**Files:**
- Create: `infra/network.tf`

**Interfaces:**
- Produces: `aws_vpc.main`、`aws_subnet.public[*]`、`aws_subnet.private[*]`、`aws_nat_gateway.main`——供后续 SG/RDS/ALB/ECS 引用（`aws_vpc.main.id`、`aws_subnet.private[*].id` 等）。

- [ ] **Step 1: 写 `infra/network.tf`**

```hcl
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags = { Name = "${local.name_prefix}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name_prefix}-igw" }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true
  tags = { Name = "${local.name_prefix}-public-${count.index}" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = local.azs[count.index]
  tags = { Name = "${local.name_prefix}-private-${count.index}" }
}

# 单个 NAT（学习省钱；生产每 AZ 一个）
resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.name_prefix}-nat-eip" }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "${local.name_prefix}-nat" }
  depends_on    = [aws_internet_gateway.main]
}

# 公有路由表：默认路由 → IGW
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${local.name_prefix}-public-rt" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# 私有路由表：默认路由 → NAT
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }
  tags = { Name = "${local.name_prefix}-private-rt" }
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# S3 网关端点（免费）：让 ECR 拉层/ S3 访问走内网
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
  tags              = { Name = "${local.name_prefix}-s3-endpoint" }
}
```

- [ ] **Step 2: 校验**

```bash
cd playground/infra
terraform fmt && terraform validate
terraform plan
```
Expected: `validate` 成功；`plan` 显示将新增 VPC/2 公有子网/2 私有子网/IGW/EIP/NAT/2 路由表/4 关联/S3 端点，**无报错**。（不 apply）

- [ ] **Step 3: 提交**

```bash
cd playground
git add infra/network.tf
git commit -m "infra: vpc, subnets, igw, nat gateway, routes, s3 endpoint"
```

---

## Task 3: 安全组链（最小权限）

**Files:**
- Create: `infra/security.tf`

**Interfaces:**
- Produces: `aws_security_group.lambda`、`.alb`、`.profile_svc`、`.stats_svc`、`.rds`——供 RDS/ALB/ECS 引用其 `.id`。
- 约定应用端口：两个 Go 服务都监听 **8080**（容器端口）。

- [ ] **Step 1: 写 `infra/security.tf`**

```hcl
# Lambda BFF：只出站（调内网 ALB）
resource "aws_security_group" "lambda" {
  name   = "${local.name_prefix}-lambda-sg"
  vpc_id = aws_vpc.main.id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "${local.name_prefix}-lambda-sg" }
}

# 内网 ALB：入站来自 Lambda-SG(80)
resource "aws_security_group" "alb" {
  name   = "${local.name_prefix}-alb-sg"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "${local.name_prefix}-alb-sg" }
}

# profile-service：入站来自 ALB-SG 和 stats-SG（Cloud Map 东西向）
resource "aws_security_group" "profile_svc" {
  name   = "${local.name_prefix}-profile-svc-sg"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id, aws_security_group.stats_svc.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "${local.name_prefix}-profile-svc-sg" }
}

# stats-service：入站来自 ALB-SG
resource "aws_security_group" "stats_svc" {
  name   = "${local.name_prefix}-stats-svc-sg"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "${local.name_prefix}-stats-svc-sg" }
}

# RDS：入站 3306 来自两个服务 SG
resource "aws_security_group" "rds" {
  name   = "${local.name_prefix}-rds-sg"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 3306
    to_port         = 3306
    protocol        = "tcp"
    security_groups = [aws_security_group.profile_svc.id, aws_security_group.stats_svc.id]
  }
  tags = { Name = "${local.name_prefix}-rds-sg" }
}
```

> 注：`profile_svc` 的入站引用了 `stats_svc.id`，`stats_svc` 又不反向引用 `profile_svc`，**无循环依赖**，Terraform 能正确排序。

- [ ] **Step 2: 校验**

```bash
cd playground/infra
terraform fmt && terraform validate && terraform plan
```
Expected: 新增 5 个安全组；无循环依赖报错。

- [ ] **Step 3: 提交**

```bash
cd playground
git add infra/security.tf
git commit -m "infra: security group chain (lambda->alb->svc->rds, cloudmap east-west)"
```

---

## Task 4: RDS（私网 MySQL + 随机密码 + Secrets Manager）

**Files:**
- Create: `infra/rds.tf`

**Interfaces:**
- Produces: `aws_db_instance.main`（`.address`、`.port`）、`aws_secretsmanager_secret.db`（存 host/user/pass/db 供服务读取）。

- [ ] **Step 1: 写 `infra/rds.tf`**

```hcl
resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db-subnets"
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = "${local.name_prefix}-db-subnets" }
}

resource "random_password" "db" {
  length  = 20
  special = false
}

resource "aws_db_instance" "main" {
  identifier             = "${local.name_prefix}-db"
  engine                 = "mysql"
  engine_version         = "8.0"
  instance_class         = var.db_instance_class
  allocated_storage      = 20
  storage_type           = "gp2"
  db_name                = var.db_name
  username               = var.db_username
  password               = random_password.db.result
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  skip_final_snapshot    = true
  deletion_protection    = false
  apply_immediately      = true
  tags                   = { Name = "${local.name_prefix}-db" }
}

resource "aws_secretsmanager_secret" "db" {
  name                    = "${local.name_prefix}-db-credentials"
  recovery_window_in_days = 0 # 学习：删了立即可重建同名
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    host     = aws_db_instance.main.address
    port     = aws_db_instance.main.port
    username = var.db_username
    password = random_password.db.result
    dbname   = var.db_name
  })
}
```

- [ ] **Step 2: 校验**

```bash
cd playground/infra
terraform fmt && terraform validate && terraform plan
```
Expected: 新增 db_subnet_group / random_password / db_instance / secret / secret_version；`publicly_accessible=false`。

- [ ] **Step 3: 提交**

```bash
cd playground
git add infra/rds.tf
git commit -m "infra: private rds mysql with generated password in secrets manager"
```

---

## Task 5: ECR（两个镜像仓库）

**Files:**
- Create: `infra/ecr.tf`

**Interfaces:**
- Produces: `aws_ecr_repository.profile`、`aws_ecr_repository.stats`（`.repository_url` 供 Plan 5 的 CI push 镜像）。

- [ ] **Step 1: 写 `infra/ecr.tf`**

```hcl
resource "aws_ecr_repository" "profile" {
  name                 = "${local.name_prefix}-profile-service"
  image_tag_mutability = "MUTABLE"
  force_delete         = true # 学习：destroy 时连镜像一起删
  image_scanning_configuration { scan_on_push = false }
  tags = { Name = "${local.name_prefix}-profile-service" }
}

resource "aws_ecr_repository" "stats" {
  name                 = "${local.name_prefix}-stats-service"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration { scan_on_push = false }
  tags = { Name = "${local.name_prefix}-stats-service" }
}
```

- [ ] **Step 2: 校验**

```bash
cd playground/infra
terraform fmt && terraform validate && terraform plan
```
Expected: 新增 2 个 ECR 仓库。

- [ ] **Step 3: 提交**

```bash
cd playground
git add infra/ecr.tf
git commit -m "infra: two ecr repositories (profile-service, stats-service)"
```

---

## Task 6: Cloud Map（私有 DNS 命名空间）

**Files:**
- Create: `infra/cloudmap.tf`

**Interfaces:**
- Produces: `aws_service_discovery_private_dns_namespace.main`（`.id` 供 Plan 3 里 ECS 服务注册 profile-service）。

- [ ] **Step 1: 写 `infra/cloudmap.tf`**

```hcl
resource "aws_service_discovery_private_dns_namespace" "main" {
  name        = "svc.internal"
  description = "east-west service discovery for ${local.name_prefix}"
  vpc         = aws_vpc.main.id
}
```

> 说明：具体的 `aws_service_discovery_service`（如 `profile.svc.internal`）在 Plan 3 建 ECS 服务时一起创建并关联；本阶段只建命名空间。

- [ ] **Step 2: 校验**

```bash
cd playground/infra
terraform fmt && terraform validate && terraform plan
```
Expected: 新增 1 个私有 DNS 命名空间。

- [ ] **Step 3: 提交**

```bash
cd playground
git add infra/cloudmap.tf
git commit -m "infra: cloud map private dns namespace (svc.internal)"
```

---

## Task 7: 内网 ALB（2 目标组 + 监听器 + 路径路由）

**Files:**
- Create: `infra/alb.tf`

**Interfaces:**
- Produces: `aws_lb.main`（`.dns_name` 供 Lambda BFF 调用）、`aws_lb_target_group.profile`、`.stats`（`type=ip`，供 Plan 2/3 ECS 服务注册）。
- 约定健康检查路径：两个服务都实现 `GET /healthz` 返回 200。

- [ ] **Step 1: 写 `infra/alb.tf`**

```hcl
resource "aws_lb" "main" {
  name               = "${local.name_prefix}-alb"
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.private[*].id
  tags               = { Name = "${local.name_prefix}-alb" }
}

resource "aws_lb_target_group" "profile" {
  name        = "${local.name_prefix}-profile-tg"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip" # Fargate awsvpc
  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = { Name = "${local.name_prefix}-profile-tg" }
}

resource "aws_lb_target_group" "stats" {
  name        = "${local.name_prefix}-stats-tg"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"
  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = { Name = "${local.name_prefix}-stats-tg" }
}

# 默认转发到 profile 服务
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.profile.arn
  }
}

# 路径路由：/leaderboard、/repos、/stats 前缀 → stats 服务
resource "aws_lb_listener_rule" "stats" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.stats.arn
  }
  condition {
    path_pattern {
      values = ["/leaderboard*", "/*/repos", "/*/stats"]
    }
  }
}
```

> 说明：目标组此刻**没有目标**（Plan 2/3 的 ECS 服务才注册进来），健康检查会显示 unhealthy——正常。本阶段只验证 ALB/TG/监听器/规则能建成。

- [ ] **Step 2: 校验**

```bash
cd playground/infra
terraform fmt && terraform validate && terraform plan
```
Expected: 新增 internal ALB / 2 目标组 / 1 监听器 / 1 规则。

- [ ] **Step 3: 提交**

```bash
cd playground
git add infra/alb.tf
git commit -m "infra: internal alb with profile/stats target groups and path routing"
```

---

## Task 8: ECS 集群（空）

**Files:**
- Create: `infra/ecs.tf`

**Interfaces:**
- Produces: `aws_ecs_cluster.main`（`.id`/`.name` 供 Plan 2/3 建服务）。

- [ ] **Step 1: 写 `infra/ecs.tf`**

```hcl
resource "aws_ecs_cluster" "main" {
  name = "${local.name_prefix}-cluster"
  setting {
    name  = "containerInsights"
    value = "disabled" # 学习省钱
  }
  tags = { Name = "${local.name_prefix}-cluster" }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE"]
}
```

- [ ] **Step 2: 校验**

```bash
cd playground/infra
terraform fmt && terraform validate && terraform plan
```
Expected: 新增 ECS 集群 + capacity providers。

- [ ] **Step 3: 提交**

```bash
cd playground
git add infra/ecs.tf
git commit -m "infra: empty ecs cluster with fargate capacity provider"
```

---

## Task 9: GitHub OIDC provider + 部署角色

**Files:**
- Create: `infra/iam.tf`

**Interfaces:**
- Produces: `aws_iam_role.deploy`（`.arn` 供 Plan 5 的 GitHub Actions assume）。

- [ ] **Step 1: 写 `infra/iam.tf`**

```hcl
data "aws_caller_identity" "current" {}

# GitHub OIDC 身份提供商（每账号一个；若已存在可改用 data 源引用）
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

resource "aws_iam_role" "deploy" {
  name = "${local.name_prefix}-gha-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }
        StringLike   = { "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:*" }
      }
    }]
  })
  tags = { Name = "${local.name_prefix}-gha-deploy" }
}

# 部署权限：ECR push、ECS 更新服务、Lambda 更新、S3/CloudFront（前端）、传角色
resource "aws_iam_role_policy" "deploy" {
  name = "${local.name_prefix}-deploy-policy"
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken", "ecr:BatchCheckLayerAvailability",
          "ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload", "ecr:BatchGetImage"
        ]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:UpdateService", "ecs:DescribeServices", "ecs:RegisterTaskDefinition"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["lambda:UpdateFunctionCode"]
        Resource = "arn:aws:lambda:${var.region}:${data.aws_caller_identity.current.account_id}:function:${local.name_prefix}-*"
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = "*"
      }
    ]
  })
}
```

> 注：thumbprint 为 GitHub OIDC 通用值；若账号里**已存在** GitHub OIDC provider，会冲突——那时把 `resource` 改成 `data "aws_iam_openid_connect_provider"` 引用现有的（执行时按 `plan` 报错提示处理）。

- [ ] **Step 2: 校验**

```bash
cd playground/infra
terraform fmt && terraform validate && terraform plan
```
Expected: 新增 OIDC provider + 角色 + 策略。

- [ ] **Step 3: 提交**

```bash
cd playground
git add infra/iam.tf
git commit -m "infra: github oidc provider and deploy iam role"
```

---

## Task 10: 输出、整体 apply、验证、destroy 演练

**Files:**
- Create: `infra/outputs.tf`

**目标**：加输出、**真正 apply 一次建全套**、验证关键资源、然后 **destroy** 拆干净（省钱）。⚠️ 本任务会产生费用（~$0.13/小时），验证完务必 destroy。

- [ ] **Step 1: 写 `infra/outputs.tf`**

```hcl
output "vpc_id" { value = aws_vpc.main.id }
output "private_subnet_ids" { value = aws_subnet.private[*].id }
output "alb_dns_name" { value = aws_lb.main.dns_name }
output "rds_endpoint" { value = aws_db_instance.main.address }
output "ecr_profile_url" { value = aws_ecr_repository.profile.repository_url }
output "ecr_stats_url" { value = aws_ecr_repository.stats.repository_url }
output "cloudmap_namespace_id" { value = aws_service_discovery_private_dns_namespace.main.id }
output "ecs_cluster_name" { value = aws_ecs_cluster.main.name }
output "deploy_role_arn" { value = aws_iam_role.deploy.arn }
output "db_secret_arn" { value = aws_secretsmanager_secret.db.arn }
```

- [ ] **Step 2: 最终校验**

```bash
cd playground/infra
terraform fmt && terraform validate && terraform plan
```
Expected: `plan` 汇总将新增约 30+ 资源，无报错。

- [ ] **Step 3: 提交代码**

```bash
cd playground
git add infra/outputs.tf
git commit -m "infra: outputs for downstream plans"
```

- [ ] **Step 4: 真正 apply（开始计费）**

```bash
cd playground/infra
terraform apply     # 审阅计划后输入 yes
```
Expected: 全部资源创建成功（RDS 约 5-10 分钟）。末尾打印 outputs。

- [ ] **Step 5: 验证关键资源**

```bash
terraform output
# RDS 确为私网：
aws rds describe-db-instances --db-instance-identifier profile-test-db \
  --region ap-southeast-1 --query 'DBInstances[0].PubliclyAccessible'
# 期望: false
# ALB 确为 internal：
aws elbv2 describe-load-balancers --region ap-southeast-1 \
  --query "LoadBalancers[?LoadBalancerName=='profile-test-alb'].Scheme"
# 期望: ["internal"]
# 两个 ECR 仓库存在：
aws ecr describe-repositories --region ap-southeast-1 \
  --query "repositories[].repositoryName"
```
**验证**：RDS `PubliclyAccessible=false`；ALB `Scheme=internal`；ECR 两个仓库在列；`terraform output` 打印全部关键地址。

- [ ] **Step 6: destroy 演练（停止计费）**

```bash
cd playground/infra
terraform destroy   # 输入 yes
```
Expected: 全部资源删除。⚠️ **确认 destroy 成功**，避免 NAT/RDS 继续计费。
**验证**：`terraform state list` 为空；AWS 控制台 NAT/RDS/ALB 均已消失。

- [ ] **Step 7: 推送到项目仓库**

```bash
cd playground
git push origin HEAD:main      # infra/** 不触发部署 workflow
```
> 之后回 brain 更新 submodule 指针：`cd ../.. && git add aws-learning/playground && git commit -m "chore: bump playground submodule (infra baseline)" && git push`

**验证**：`Adophlidu/aws-learning` 上有 `infra/` 全部文件；GitHub Actions **未触发部署**（infra/** 不在触发路径）。

---

## 自检：spec 覆盖核对（Plan 1 范围）

- VPC + 公/私子网跨 2 AZ → Task 2 ✅
- 单 NAT Gateway + S3 免费端点 → Task 2 ✅
- 安全组最小权限链（含 stats→profile 东西向）→ Task 3 ✅
- 私网 RDS（无公网）+ 密码进 Secrets Manager → Task 4 ✅
- 2 个 ECR 仓库 → Task 5 ✅
- Cloud Map 私有命名空间 → Task 6 ✅
- 内网 ALB + 2 目标组 + 路径路由 → Task 7 ✅
- ECS 集群（空，Fargate）→ Task 8 ✅
- GitHub OIDC + 部署角色 → Task 9 ✅
- Terraform workspace（test/prod 隔离命名）→ Task 1 ✅
- 一键 apply / 一键 destroy（省钱）→ Task 10 ✅
- 应用服务任务 / Go 代码 / Lambda 重构 → **属 Plan 2+，本计划不含**（范围正确）

## 交接给后续 Plan

- Plan 2 用到本阶段的：`ecs_cluster_name`、`private_subnet_ids`、`profile_svc`/`rds` SG、`ecr_profile_url`、`db_secret_arn`、`alb` + `profile` 目标组。
- Plan 3 用到：`cloudmap_namespace_id`、`stats` 目标组、`ecr_stats_url`、`stats_svc` SG。
- Plan 5 用到：`deploy_role_arn`。
