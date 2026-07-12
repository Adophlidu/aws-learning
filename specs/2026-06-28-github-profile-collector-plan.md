# GitHub Profile 收集器 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **学习项目说明**：操作由用户亲手完成，本计划是"教练手册"——每个任务给目标、步骤、验证方式。控制台任务用具体验证动作确认；后端纯逻辑用单元测试（TDD）。

**Goal:** 搭建一个全栈项目：前端提交 GitHub token → 后端用它抓取 GitHub profile 存入 RDS → 提供列表/详情查询；前端托管 S3+CloudFront，合并 main 自动部署。

**Architecture:** 前端(better-t-stack, 用户提供 zip) → S3+CloudFront；后端 API Gateway(HTTP, CORS) → Lambda(Node.js) → GitHub API + RDS MySQL(公开访问)；CI/CD 用 GitHub Actions + OIDC 临时凭证，合并 main 自动部署代码（基础设施一次性手动建）。

**Tech Stack:** AWS (RDS MySQL, Lambda Node.js 22.x, API Gateway HTTP API, S3, CloudFront, IAM OIDC), mysql2, 内置 fetch, GitHub Actions, better-t-stack(前端)。

## Global Constraints

- 区域固定 **ap-southeast-1（新加坡）**，所有资源同区域。
- 登录用 **IAM 用户**，不用 root。
- token **绝不入库、绝不写日志**，用完即弃。
- RDS 公开访问 + 安全组 + 强密码；Lambda 不进 VPC。
- Lambda 运行时 **Node.js 22.x**；DB 连接信息走**环境变量**，不硬编码。
- 全程控制在免费套餐内；RDS 是常开型，阶段性提醒可停/删。
- 设计文档：`playground/docs/2026-06-28-github-profile-collector-design.md`（本计划的依据）。

---

## 文件结构

```
playground/                          ← git 仓库根
├── docs/                            ← 设计文档（已存在）
├── specs/                           ← 本计划（已存在）
├── backend/
│   ├── handler.js                   ← Lambda 入口：路由 + DB + GitHub 调用
│   ├── mapper.js                    ← 纯函数：GitHub profile → DB 行（可单元测试）
│   ├── mapper.test.js               ← mapper 单元测试（node:test）
│   └── package.json                 ← 依赖 mysql2 + test 脚本
├── frontend/                        ← 用户提供 zip 解压到此
├── .github/workflows/deploy.yml     ← 自动部署
├── .gitignore
└── README.md
```

---

## Task 1: 项目脚手架与 git 初始化

**Files:**
- Create: `playground/.gitignore`, `playground/README.md`, `playground/backend/package.json`

**目标**：建好目录骨架、初始化 git，为后续提交做准备。

- [ ] **Step 1: 建后端目录与 package.json**

`playground/backend/package.json`：
```json
{
  "name": "profile-api-backend",
  "version": "1.0.0",
  "private": true,
  "main": "handler.js",
  "scripts": {
    "test": "node --test"
  },
  "dependencies": {
    "mysql2": "^3.11.0"
  }
}
```

- [ ] **Step 2: 写 `.gitignore`**

`playground/.gitignore`：
```
# Node
node_modules/
backend/function.zip
# frontend
frontend/dist/
frontend/.env*
# OS
.DS_Store
```

- [ ] **Step 3: 写一个最简 `README.md`**

`playground/README.md`：
```markdown
# GitHub Profile Collector

全栈练习项目：提交 GitHub token，抓取并存储 GitHub profile，提供查询接口。
- 前端：better-t-stack → S3 + CloudFront
- 后端：API Gateway + Lambda(Node.js) + RDS MySQL
- CI/CD：GitHub Actions (OIDC)，合并 main 自动部署

详见 docs/ 与 specs/。
```

- [ ] **Step 4: 初始化 git 并首次提交**

```bash
cd playground
git init
git add .
git commit -m "chore: scaffold project structure"
```

**验证**：`git log --oneline` 显示一条提交；`ls -R` 显示 backend/ docs/ specs/ 就位。

---

## Task 2: 创建并配置 RDS MySQL 数据库

**目标**：在控制台建一个公开访问的 MySQL 实例，能从本地连上。

- [ ] **Step 1: 启动 RDS 实例**

控制台 → 区域确认 ap-southeast-1 → 搜 `RDS` → Create database：
- Standard create → **MySQL**
- Templates: **Free tier**
- DB instance identifier: `profile-db`
- Master username: `admin`
- Master password: 设一个**强密码**并记下来
- Instance: `db.t3.micro`（免费套餐）
- Storage: 默认 20GB，**关闭** Storage autoscaling
- **Connectivity → Public access: Yes**
- VPC security group: **Create new**，命名 `profile-db-sg`
- 其余默认 → Create database

- [ ] **Step 2: 配置安全组放行 3306**

EC2 → Security Groups → `profile-db-sg` → Inbound rules → Edit：
- 加一条：Type **MySQL/Aurora (3306)**，Source **My IP**（先只放行你自己，方便本地建表）
- 保存

> ⚠️ Task 5 会把来源临时放宽到 `0.0.0.0/0`（仅学习，让 VPC 外的 Lambda 能连库；生产用私有子网+VPC）。先放 My IP 够本地建表。

- [ ] **Step 3: 记录连接信息**

实例 Available 后，复制 **Endpoint**（形如 `profile-db.xxxx.ap-southeast-1.rds.amazonaws.com`）。记下 endpoint、端口 3306、用户名 admin、密码。

- [ ] **Step 4: 本地连库并建库建表**

本地需 mysql 客户端（`brew install mysql-client` 或 GUI 如 TablePlus）：
```bash
mysql -h <你的endpoint> -P 3306 -u admin -p
```
执行：
```sql
CREATE DATABASE profiles_app;
USE profiles_app;
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
SHOW TABLES;
DESCRIBE profiles;
```

**验证**：`SHOW TABLES;` 列出 `profiles`；`DESCRIBE profiles;` 显示全部字段。

---

## Task 3: 后端纯逻辑 + 单元测试（TDD）

**Files:**
- Create: `backend/mapper.js`, `backend/mapper.test.js`

**Interfaces:**
- Produces: `toRow(profile: object) -> object` —— 把 GitHub `/user` 响应映射为 DB 行对象，键为 profiles 表列名（不含 id/stored_at）。

- [ ] **Step 1: 写失败的测试**

`backend/mapper.test.js`：
```javascript
const test = require("node:test");
const assert = require("node:assert");
const { toRow } = require("./mapper");

test("toRow maps core fields", () => {
  const profile = {
    id: 583231,
    login: "octocat",
    name: "The Octocat",
    avatar_url: "https://avatars.githubusercontent.com/u/583231",
    bio: "hello",
    company: "@github",
    location: "SF",
    public_repos: 8,
    followers: 100,
    following: 9,
    created_at: "2011-01-25T18:44:36Z",
  };
  const row = toRow(profile);
  assert.strictEqual(row.github_id, 583231);
  assert.strictEqual(row.login, "octocat");
  assert.strictEqual(row.github_created_at, "2011-01-25 18:44:36");
});

test("toRow handles missing optional fields", () => {
  const profile = { id: 1, login: "a", created_at: "2020-01-01T00:00:00Z" };
  const row = toRow(profile);
  assert.strictEqual(row.name, null);
  assert.strictEqual(row.public_repos, 0);
  assert.strictEqual(row.followers, 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd playground/backend
node --test
```
Expected: FAIL（`Cannot find module './mapper'`）。

- [ ] **Step 3: 写最小实现**

`backend/mapper.js`：
```javascript
function toRow(profile) {
  const created = profile.created_at;
  const githubCreatedAt = created
    ? created.replace("T", " ").replace("Z", "")
    : null;
  return {
    github_id: profile.id,
    login: profile.login,
    name: profile.name ?? null,
    avatar_url: profile.avatar_url ?? null,
    bio: profile.bio ?? null,
    company: profile.company ?? null,
    location: profile.location ?? null,
    public_repos: profile.public_repos ?? 0,
    followers: profile.followers ?? 0,
    following: profile.following ?? 0,
    github_created_at: githubCreatedAt,
  };
}

module.exports = { toRow };
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test
```
Expected: 2 tests passed。

- [ ] **Step 5: 提交**

```bash
cd playground
git add backend/mapper.js backend/mapper.test.js
git commit -m "feat: add github profile -> db row mapper with tests"
```

---

## Task 4: 后端 handler（路由 + GitHub 调用 + DB 读写）

**Files:**
- Create: `backend/handler.js`

**Interfaces:**
- Consumes: `mapper.toRow`
- Produces: `exports.handler(event)` —— API Gateway HTTP API (payload v2.0) 入口，按 `event.routeKey` 分发。

- [ ] **Step 1: 写 handler.js**

`backend/handler.js`：
```javascript
const mysql = require("mysql2/promise");
const { toRow } = require("./mapper");

const CORS_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function resp(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

async function getConn() {
  return mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT || 3306),
    connectTimeout: 5000,
  });
}

async function fetchGithubProfile(token) {
  return fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "github-profile-collector",
    },
  });
}

async function createProfile(body) {
  const token = body && body.token;
  if (!token) return resp(400, { error: "token is required" });

  let res;
  try {
    res = await fetchGithubProfile(token);
  } catch (e) {
    return resp(502, { error: "github api error" });
  }
  if (res.status === 401) return resp(401, { error: "invalid github token" });
  if (!res.ok) return resp(502, { error: "github api error" });

  const profile = await res.json();
  const row = toRow(profile);

  const conn = await getConn();
  try {
    await conn.execute(
      `INSERT INTO profiles
        (github_id, login, name, avatar_url, bio, company, location,
         public_repos, followers, following, github_created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         login=VALUES(login), name=VALUES(name), avatar_url=VALUES(avatar_url),
         bio=VALUES(bio), company=VALUES(company), location=VALUES(location),
         public_repos=VALUES(public_repos), followers=VALUES(followers),
         following=VALUES(following), github_created_at=VALUES(github_created_at)`,
      [row.github_id, row.login, row.name, row.avatar_url, row.bio, row.company,
       row.location, row.public_repos, row.followers, row.following, row.github_created_at]
    );
    const [rows] = await conn.execute(
      "SELECT * FROM profiles WHERE github_id=?", [row.github_id]
    );
    return resp(201, rows[0]);
  } finally {
    await conn.end();
  }
}

async function listProfiles() {
  const conn = await getConn();
  try {
    const [rows] = await conn.execute(
      "SELECT id, login, name, avatar_url, public_repos, followers " +
      "FROM profiles ORDER BY id DESC"
    );
    return resp(200, rows);
  } finally {
    await conn.end();
  }
}

async function getProfile(id) {
  const conn = await getConn();
  try {
    const [rows] = await conn.execute("SELECT * FROM profiles WHERE id=?", [id]);
    if (rows.length === 0) return resp(404, { error: "profile not found" });
    return resp(200, rows[0]);
  } finally {
    await conn.end();
  }
}

exports.handler = async (event) => {
  const route = event.routeKey || "";
  if (route.startsWith("OPTIONS")) return resp(200, {});
  try {
    if (route === "POST /profiles") {
      const body = JSON.parse(event.body || "{}");
      return await createProfile(body);
    }
    if (route === "GET /profiles") return await listProfiles();
    if (route === "GET /profiles/{id}") {
      return await getProfile(event.pathParameters.id);
    }
    return resp(404, { error: "not found" });
  } catch (e) {
    return resp(500, { error: "internal error" });
  }
};
```

- [ ] **Step 2: 本地装依赖并静态检查能 require**

```bash
cd playground/backend
npm install
node -e "require('./handler'); console.log('ok')"
```
Expected: 打印 `ok`（无语法/导入错误）。

- [ ] **Step 3: 提交**

```bash
cd playground
git add backend/handler.js backend/package.json backend/package-lock.json
git commit -m "feat: add lambda handler with 3 routes, github fetch, rds upsert"
```

---

## Task 5: 部署 Lambda + 打包 mysql2 依赖

**目标**：把后端代码连同 node_modules 打成 zip，建 Lambda 函数并上传，配好环境变量。

- [ ] **Step 1: 打包代码与依赖**

```bash
cd playground/backend
npm install --omit=dev
zip -r function.zip handler.js mapper.js node_modules package.json
```
**验证**：`unzip -l function.zip` 里能看到 `handler.js`、`mapper.js`、`node_modules/mysql2/` 目录。

- [ ] **Step 2: 创建 Lambda 函数**

控制台 → Lambda → Create function：
- Author from scratch；Name `profile-api`；Runtime **Node.js 22.x**；Architecture x86_64 → Create

- [ ] **Step 3: 上传 zip**

函数页 → Code → Upload from → **.zip file** → 选 `function.zip` → Save。
- Runtime settings → Handler 确认为 **`handler.handler`**（文件 handler.js 的 handler 导出）。

- [ ] **Step 4: 配置环境变量**

Configuration → Environment variables → Edit，加：
- `DB_HOST` = RDS endpoint
- `DB_USER` = admin
- `DB_PASSWORD` = 你的强密码
- `DB_NAME` = profiles_app
- `DB_PORT` = 3306

- [ ] **Step 5: 放宽超时与 RDS 安全组**

- Configuration → General configuration → Edit → Timeout 改 **15 秒**。
- EC2 → Security Groups → `profile-db-sg` → 入站 3306 来源**追加 `0.0.0.0/0`**（⚠️ 仅学习；生产用私有子网+VPC，绝不公开 DB）。

- [ ] **Step 6: 控制台测试 POST 逻辑**

函数 Test 标签 → 新建测试事件：
```json
{
  "routeKey": "POST /profiles",
  "body": "{\"token\": \"粘贴你的真实GitHub_token\"}"
}
```
> 生成 token：GitHub → Settings → Developer settings → Personal access tokens → 生成一个 classic token（读 /user 公开信息无需任何 scope）。
Test。Expected: `statusCode 201`，body 是你的 profile。

**验证**：回 mysql 执行 `SELECT login, public_repos FROM profiles;`，能看到你的记录。

---

## Task 6: 创建 API Gateway（3 路由 + CORS）

**目标**：把 Lambda 暴露成 HTTP API，配 3 条路由和 CORS。

- [ ] **Step 1: 创建 HTTP API**

控制台 → API Gateway → Create API → **HTTP API** → Build：
- API name: `profile-http-api` → Next（集成下一步在路由里加）

- [ ] **Step 2: 配置 3 条路由**

左侧 Routes → Create：
- `POST` `/profiles`
- `GET` `/profiles`
- `GET` `/profiles/{id}`

每条路由 → Attach integration → Create and attach an integration → Lambda → 选 `profile-api`。

- [ ] **Step 3: 开启 CORS**

左侧 CORS → Configure：
- Access-Control-Allow-Origin: `*`（学习用；上线后填前端域名）
- Access-Control-Allow-Methods: `GET, POST, OPTIONS`
- Access-Control-Allow-Headers: `content-type`
- Save

- [ ] **Step 4: 拿到 API 地址并测试**

复制 **Invoke URL**（形如 `https://abc.execute-api.ap-southeast-1.amazonaws.com`）：
```bash
curl https://<invoke-url>/profiles
curl -X POST https://<invoke-url>/profiles \
  -H "Content-Type: application/json" \
  -d '{"token":"你的GitHub_token"}'
curl https://<invoke-url>/profiles/1
curl -X POST https://<invoke-url>/profiles -d '{}'      # 期望 400
curl https://<invoke-url>/profiles/99999                 # 期望 404
```
**验证**：POST 返回 201 + profile；GET 列表含数据；GET 详情返回完整字段；异常返回 400/404。

- [ ] **Step 5: 记录 Invoke URL** 供前端与文档使用。

---

## Task 7: 创建前端托管基础设施（S3 + CloudFront）

**目标**：建好放前端的 S3 桶和 CloudFront 分发（先建空壳）。

- [ ] **Step 1: 建 S3 桶**

控制台 → S3 → Create bucket：
- Bucket name: `profile-frontend-<你的唯一后缀>`（全球唯一）
- Region: ap-southeast-1
- Block all public access: **保持勾选**（用 CloudFront 访问）
- 其余默认 → Create

- [ ] **Step 2: 建 CloudFront 分发**

控制台 → CloudFront → Create distribution：
- Origin domain: 选上面的 S3 桶
- Origin access: **Origin access control (OAC)** → Create new OAC → 用它
- Default root object: `index.html`
- 其余默认 → Create distribution
- 创建后复制提示的**桶策略** → 回 S3 桶 → Permissions → Bucket policy → 粘贴保存。

- [ ] **Step 3: 配置 SPA 路由回退**

CloudFront 分发 → Error pages → Create custom error response：
- 403 → Response page path `/index.html` → HTTP code 200
- 404 → `/index.html` → 200

- [ ] **Step 4: 记录 CloudFront 域名与分发 ID**

记下 **Domain name**（`dxxxx.cloudfront.net`）和 **Distribution ID**（CI/CD 刷缓存用）。

**验证**：访问 `https://<cloudfront域名>` 现返回 403/404（桶里还没文件）——正常，Task 10 上传后即正常。

---

## Task 8: 配置 IAM OIDC 身份提供商 + 部署角色

**目标**：让 GitHub Actions 用 OIDC 临时凭证部署，无需在 GitHub 存长期密钥。

- [ ] **Step 1: 添加 GitHub OIDC 身份提供商**

IAM → Identity providers → Add provider：
- Type: **OpenID Connect**
- Provider URL: `https://token.actions.githubusercontent.com` → Get thumbprint
- Audience: `sts.amazonaws.com` → Add provider

- [ ] **Step 2: 创建部署角色**

IAM → Roles → Create role：
- Trusted entity: **Web identity** → Identity provider 选刚建的 → Audience `sts.amazonaws.com`
- 创建后编辑信任策略（把 `<OWNER>/<REPO>` 换成你的）：
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Federated": "arn:aws:iam::930698106220:oidc-provider/token.actions.githubusercontent.com"},
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {"token.actions.githubusercontent.com:aud": "sts.amazonaws.com"},
      "StringLike": {"token.actions.githubusercontent.com:sub": "repo:<OWNER>/<REPO>:ref:refs/heads/main"}
    }
  }]
}
```

- [ ] **Step 3: 给角色加最小权限**

附加内联策略（把桶名/函数名换成你的）：
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect":"Allow","Action":["s3:PutObject","s3:DeleteObject","s3:ListBucket"],
     "Resource":["arn:aws:s3:::profile-frontend-<后缀>","arn:aws:s3:::profile-frontend-<后缀>/*"]},
    {"Effect":"Allow","Action":["cloudfront:CreateInvalidation"],"Resource":"*"},
    {"Effect":"Allow","Action":["lambda:UpdateFunctionCode"],
     "Resource":"arn:aws:lambda:ap-southeast-1:930698106220:function:profile-api"}
  ]
}
```

- [ ] **Step 4: 记录角色 ARN**（`arn:aws:iam::930698106220:role/<role-name>`）。

---

## Task 9: GitHub 仓库 + Actions 自动部署后端

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: 在 GitHub 建仓库并推送**

GitHub 新建仓库 `<REPO>`（与 Task 8 信任策略一致）：
```bash
cd playground
git branch -M main
git remote add origin git@github.com:<OWNER>/<REPO>.git
git push -u origin main
```

- [ ] **Step 2: 写 workflow**

`.github/workflows/deploy.yml`（把占位符换成你的值）：
```yaml
name: deploy
on:
  push:
    branches: [main]
permissions:
  id-token: write
  contents: read
env:
  AWS_REGION: ap-southeast-1
  LAMBDA_FUNCTION: profile-api
  S3_BUCKET: profile-frontend-<后缀>
  CLOUDFRONT_ID: <分发ID>
  ROLE_ARN: arn:aws:iam::930698106220:role/<role-name>
jobs:
  backend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ env.ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Package lambda
        run: |
          cd backend
          npm install --omit=dev
          zip -r function.zip handler.js mapper.js node_modules package.json
      - name: Deploy lambda
        run: |
          aws lambda update-function-code \
            --function-name $LAMBDA_FUNCTION \
            --zip-file fileb://backend/function.zip

  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ env.ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Build frontend
        run: |
          cd frontend
          npm ci
          npm run build
      - name: Sync to S3
        run: aws s3 sync frontend/dist s3://$S3_BUCKET --delete
      - name: Invalidate CloudFront
        run: aws cloudfront create-invalidation --distribution-id $CLOUDFRONT_ID --paths "/*"
```

> 注：此时 `frontend/` 还没内容，`frontend` job 会失败——正常。先验证 `backend` job。

- [ ] **Step 3: 提交并触发**

```bash
cd playground
git add .github/workflows/deploy.yml
git commit -m "ci: add github actions deploy workflow (oidc)"
git push
```

**验证**：GitHub → Actions → 最新运行里 **backend job 成功**。Lambda 控制台函数"最近修改时间"已更新。

---

## Task 10: 接入前端（用户提供 zip）并端到端联调

**目标**：把用户的前端代码放进 `frontend/`，配好 API 地址，推送触发自动部署，跑通全流程。

- [ ] **Step 1: 解压前端代码到 frontend/**

把压缩包解压到 `playground/frontend/`，确认有 `package.json` 与 `npm run build`，build 产物输出到 `dist/`（若不是 dist，相应改 workflow 路径）。

- [ ] **Step 2: 配置前端调用的 API 地址**

把后端基址设为 Task 6 的 Invoke URL。better-t-stack 通常用环境变量（如 `VITE_API_URL`）：
- 本地 `frontend/.env`（不提交）：`VITE_API_URL=https://<invoke-url>`
- CI 构建值：写入可提交的 `frontend/.env.production`（确认不含密钥）。
- 代码里用该变量拼请求（如 `${import.meta.env.VITE_API_URL}/profiles`）。

- [ ] **Step 3: 本地验证前端 build**

```bash
cd playground/frontend
npm ci
npm run build
```
Expected: 生成 `dist/`，无报错。

- [ ] **Step 4: 提交并触发全量部署**

```bash
cd playground
git add frontend .github/workflows/deploy.yml
git commit -m "feat: add frontend and wire to api"
git push
```
**验证**：GitHub Actions 中 **frontend + backend 两个 job 都成功**。

- [ ] **Step 5: 端到端测试**

浏览器打开 `https://<cloudfront域名>`：
- 页面正常加载（不再 403）
- 输入真实 GitHub token → 提交 → 入库成功反馈
- 列表显示已入库 profile；详情显示完整字段
- DevTools Network 确认调 API **无 CORS 报错**

**验证（全链路）**：前端(CloudFront) → API(Gateway) → Lambda → GitHub + RDS 全部跑通。

---

## Task 11: 收尾与省钱

- [ ] **Step 1: 写运行手册到 README**

补进 `README.md`：Invoke URL、CloudFront 域名、S3 桶名、Lambda 函数名、如何打包、如何停/删 RDS。

- [ ] **Step 2: 成本提醒落档**

注明：**RDS 是常开型**，不用时去 RDS 控制台 **Stop**（最多停 7 天自动重启）或 **Delete**。Lambda/API Gateway/S3/CloudFront 闲置基本免费。

- [ ] **Step 3: 提交**

```bash
cd playground
git add README.md
git commit -m "docs: add runbook and cost notes"
git push
```

---

## 自检：spec 覆盖核对

- 三接口 POST/GET/GET{id} → Task 4/6 ✅
- 数据模型 profiles 表 → Task 2 ✅
- token 用完即弃、不入库不记日志 → Task 4 ✅
- 去重 ON DUPLICATE KEY → Task 4 ✅
- 错误处理 400/401/404/500/502 → Task 4 ✅
- RDS 公开访问 + 安全组 → Task 2/5 ✅
- Lambda(Node.js 22.x) + 环境变量 + mysql2 打包 → Task 4/5 ✅
- API Gateway + CORS → Task 6 ✅
- S3 + CloudFront(含 SPA 回退) → Task 7 ✅
- IAM OIDC 角色（最小权限）→ Task 8 ✅
- GitHub Actions 合并 main 自动部署前后端 → Task 9/10 ✅
- 前端接入（用户提供 zip）→ Task 10 ✅
- 成本/省钱提示 → Task 11 ✅
```
