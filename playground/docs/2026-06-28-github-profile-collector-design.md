# 设计文档：GitHub Profile 收集器

> 日期：2026-06-28
> 状态：设计已确认，待实现
> 项目根目录：`playground/`

## 1. 目标

一个全栈小项目：用户在前端输入自己的 GitHub Personal Access Token，系统用它调用 GitHub API 取回该用户的公开 profile，存入数据库；并提供"查看所有已入库 profile 列表"和"按 id 查看详情"两个查询接口。

作为学习载体，覆盖：Lambda、API Gateway、RDS、S3、CloudFront、IAM(OIDC)、GitHub Actions CI/CD。

## 2. 整体架构

```
┌─ 前端（better-t-stack，用户自建）→ build → S3 ← CloudFront(CDN/HTTPS) ← 用户浏览器
│
├─ 后端：API Gateway(HTTP API, 开 CORS) → Lambda(Python 3.13)
│            ├→ GitHub API（取 profile，token 用完即弃）
│            └→ RDS MySQL（公开访问，存/查 profile）
│
└─ CI/CD：合并到 main → GitHub Actions（OIDC 临时凭证）
             ├ 前端：build → aws s3 sync → 刷新 CloudFront 缓存
             └ 后端：打包(含 pymysql) → aws lambda update-function-code
```

- 区域：**ap-southeast-1（新加坡）**
- Lambda 不进 VPC（保留公网访问以调 GitHub）；RDS 开"公开访问"用安全组+强密码保护。

## 3. 组件清单

| 组件 | 技术 | 说明 |
|------|------|------|
| 前端 | better-t-stack（用户自建） | 静态构建产物，托管到 S3 |
| CDN | CloudFront | 全球加速 + HTTPS，永久免费套餐 1TB/月 |
| 前端存储 | S3 | 存静态文件，免费套餐 5GB |
| API 入口 | API Gateway (HTTP API) | 3 个路由，开启 CORS |
| 计算 | Lambda (Python 3.13)，单函数内部分发 | 处理 3 个接口，调 GitHub + 读写 RDS |
| 数据库 | RDS MySQL (db.t3.micro) | 公开访问，免费套餐 750h/月 |
| 权限 | IAM OIDC 角色 | 供 GitHub Actions 临时假设，无长期密钥 |
| CI/CD | GitHub Actions | 合并 main 触发自动部署 |

## 4. API 接口设计

| 方法 | 路径 | 作用 | 输入 | 成功输出 |
|------|------|------|------|----------|
| POST | `/profiles` | 提交 token，抓取并入库 | body: `{"token":"ghp_xxx"}` | 201 + 入库后的 profile（含自有 id） |
| GET | `/profiles` | 查所有已入库 profile | 无 | 200 + profile 数组（精简字段：id, login, name, avatar_url, public_repos, followers） |
| GET | `/profiles/{id}` | 按自有 id 查详情 | 路径参数 id | 200 + 单个 profile 全部字段 |

### POST /profiles 流程
1. 从 body 取 token；缺失 → 返回 400。
2. 用 token 调 GitHub `GET https://api.github.com/user`（header: `Authorization: Bearer <token>`）。
3. GitHub 返回 401 → 返回 401（token 无效）；其他错误 → 502。
4. 解析 profile 字段，`INSERT ... ON DUPLICATE KEY UPDATE` 写入 `profiles` 表（按 github_id 去重）。
5. 返回入库后的记录（含自有 id）。
6. token 仅存在于内存，处理完即丢弃，**绝不入库、绝不写日志**。

## 5. 数据模型

表 `profiles`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INT AUTO_INCREMENT PRIMARY KEY | 自有 id，用于 `/profiles/{id}` |
| `github_id` | BIGINT UNIQUE NOT NULL | GitHub 用户 id，去重键 |
| `login` | VARCHAR(255) | GitHub 用户名 |
| `name` | VARCHAR(255) | 昵称（可空） |
| `avatar_url` | VARCHAR(512) | 头像 |
| `bio` | TEXT | 简介（可空） |
| `company` | VARCHAR(255) | 公司（可空） |
| `location` | VARCHAR(255) | 地区（可空） |
| `public_repos` | INT | 公开仓库数 |
| `followers` | INT | 粉丝数 |
| `following` | INT | 关注数 |
| `github_created_at` | DATETIME | GitHub 账号创建时间 |
| `stored_at` | TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP | 入库/更新时间 |

建表 SQL（实现时执行）：
```sql
CREATE TABLE profiles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  github_id BIGINT UNIQUE NOT NULL,
  login VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  avatar_url VARCHAR(512),
  bio TEXT,
  company VARCHAR(255),
  location VARCHAR(255),
  public_repos INT,
  followers INT,
  following INT,
  github_created_at DATETIME,
  stored_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

## 6. 错误处理

| 情况 | HTTP 状态 | 响应 |
|------|-----------|------|
| body 缺 token / 格式错 | 400 | `{"error":"token is required"}` |
| token 无效/过期（GitHub 401） | 401 | `{"error":"invalid github token"}` |
| `/profiles/{id}` id 不存在 | 404 | `{"error":"profile not found"}` |
| GitHub 限流/网络错误 | 502 | `{"error":"github api error"}` |
| 数据库错误 | 500 | `{"error":"internal error"}` |

所有响应均带 CORS 头；token 不出现在任何日志中。

## 7. CI/CD（GitHub Actions + OIDC）

**前提**：基础设施一次性在控制台建好；Actions 只更新代码，不重建基础设施。

**OIDC 信任**：在 AWS 建一个 IAM 角色，信任策略允许该 GitHub 仓库的 Actions 假设它；角色权限限定为：`s3:PutObject/ListBucket`（前端桶）、`cloudfront:CreateInvalidation`、`lambda:UpdateFunctionCode`（目标函数）。GitHub 不保存任何长期密钥。

**工作流 `.github/workflows/deploy.yml`（合并 main 触发）：**
- job `frontend`：checkout → 装依赖 → build → `aws s3 sync frontend/dist s3://<bucket>` → `aws cloudfront create-invalidation`
- job `backend`：checkout → `pip install -r backend/requirements.txt -t build/` → 复制 handler → zip → `aws lambda update-function-code`
- 两个 job 用 `aws-actions/configure-aws-credentials` 通过 OIDC 拿临时凭证。
- 可选优化：用 path 过滤，仅改动对应目录时才跑对应 job。

## 8. 仓库结构

```
playground/                       ← git 仓库根，推到 GitHub
├── docs/
│   └── 2026-06-28-github-profile-collector-design.md  ← 本文档
├── frontend/                     ← 用户用 better-t-stack 建
├── backend/
│   ├── handler.py                ← Lambda 入口 + 3 接口逻辑
│   └── requirements.txt          ← pymysql
├── .github/
│   └── workflows/
│       └── deploy.yml            ← 自动部署
├── .gitignore
└── README.md
```

## 9. 实现阶段（供后续 plan 拆解）

**阶段一 · 一次性建基础设施（控制台手动）**
1. 创建 RDS MySQL（公开访问、安全组、强密码），建库建表
2. 创建 Lambda 函数（Python 3.13），配环境变量（DB host/user/password/name）
3. 创建 API Gateway（HTTP API，3 路由指向 Lambda，开 CORS）
4. 创建 S3 桶 + CloudFront 分发
5. 创建 IAM OIDC 身份提供商 + 部署角色

**阶段二 · 代码与自动化**
6. 写 `backend/handler.py`（含 GitHub 调用、RDS 读写、错误处理）+ `requirements.txt`
7. 本地/控制台先验证后端 3 接口（curl）
8. 建 GitHub 仓库，写 `deploy.yml`，验证合并 main 自动部署后端
9. 用户用 better-t-stack 建前端，接上 API 地址，验证前端自动部署到 S3/CloudFront
10. 端到端联调（CORS、完整流程）

## 10. 安全说明：学习版 vs 生产版

| 方面 | 本项目（学习） | 生产环境 |
|------|----------------|----------|
| RDS 网络 | 公开访问 + 安全组 + 强密码 | 私有子网 + Lambda 进 VPC + RDS Proxy |
| API 鉴权 | Open（无鉴权） | API Key / Cognito / JWT |
| Lambda→RDS 连接 | 每次新建连接 | RDS Proxy 连接池 |
| token | 用完即弃 ✅ | 同样（与生产一致） |
| 部署凭证 | OIDC 临时凭证 ✅ | 同样（与生产一致） |

## 11. 成本

- S3 + CloudFront：免费套餐内 ≈ 0；CloudFront 1TB/月永久免费。
- Lambda + API Gateway：每月百万级调用免费，闲置 0 元。
- RDS：免费套餐 750h/月（前 12 月）；**注意它是常开型**，学完想省钱应停止或删除。
- 1 美元 Budgets 告警兜底。

## 12. 范围之外（YAGNI，本期不做）

- 删除/搜索/分页接口（先做最小三接口）
- IaC（Terraform/SAM）自动化建基础设施（基础设施仍手动建）
- API 鉴权、token 持久化与定时刷新
- 自定义域名
