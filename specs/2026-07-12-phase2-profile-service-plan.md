# 架构改造 Plan 2：profile-service(Go) + Lambda BFF + API Gateway 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **学习项目说明**：教练手册。Claude 写代码（Go / Dockerfile / Terraform / Node），用户亲手跑 `terraform` / `docker` / `aws` 命令并去控制台看。纯逻辑用 Go 单元测试（TDD，本地免费）；容器化本地 docker-compose 联调（免费）；上云集成测试才 apply（花钱），验证完 destroy。

**Goal:** 让新架构第一次"通电"——公网 `POST /profiles {token}` → API Gateway → Lambda BFF(VPC内) → 内网 ALB → **profile-service(Go/Fargate)** → 私网 RDS，跑通 profile 域的 建/列/查/搜。

**Architecture:** profile-service 是拥有 `profiles` 表的 Go 领域服务，跑在 Fargate、挂 Plan 1 的 profile 目标组 + 注册到 Cloud Map；Lambda BFF(Node) 在 VPC 私网、纯转发到内网 ALB、不碰 DB；API Gateway(HTTP) 做公网入口。

**Tech Stack:** Go 1.22（`net/http` ServeMux 方法+路径路由）、`go-sql-driver/mysql`、Docker 多阶段构建、Node.js 22（BFF fetch 转发）、Terraform（ECS 任务/服务、IAM、Cloud Map service、Lambda-in-VPC、API Gateway v2）。

## Global Constraints

- 区域 **ap-southeast-1**；命名前缀 `local.name_prefix`（=`profile-${workspace}`）。
- profile-service 监听 **8080**，`GET /healthz` 只做存活探测（**不查 DB**）。
- DB 连接信息由 ECS 从 **Secrets Manager 注入环境变量**（不硬编码）；GitHub token 透传即弃、不入库不记日志。
- 沿用 Plan 1 已建资源：`ecs_cluster`、`private_subnet`、`profile_svc`/`lambda` SG、`profile` 目标组、`cloudmap` 命名空间、`ecr_profile`、`db_secret`、`alb`。
- 依据设计：`playground/docs/2026-07-12-architecture-overhaul-design.md`。
- 上云验证后 **`terraform destroy`**。

---

## 文件结构

```
playground/
├── services/profile-service/       ← 新增 Go 服务
│   ├── go.mod
│   ├── main.go            # 路由 + 启动
│   ├── config.go          # 读环境变量
│   ├── models.go          # Profile / GithubUser / SearchFilter 结构
│   ├── mapper.go          # GithubUser → Profile（纯函数，可测）
│   ├── mapper_test.go     # 单元测试
│   ├── github.go          # 调 GitHub /user
│   ├── store.go           # DB：建表/upsert/list/get
│   ├── handler.go         # HTTP handlers
│   └── Dockerfile
├── bff/                            ← Lambda BFF（Node，替代老 backend/）
│   ├── index.mjs          # 转发到内网 ALB
│   └── package.json
└── infra/                          ← 新增 .tf
    ├── iam-ecs.tf         # ECS 执行角色/任务角色 + 日志组
    ├── ecs-profile.tf     # profile-service 任务定义 + 服务 + Cloud Map service
    └── bff.tf             # Lambda(VPC) + API Gateway v2
```

---

## Task 1: Go 服务骨架 + /healthz + 本地跑通

**Files:**
- Create: `services/profile-service/go.mod`, `main.go`, `config.go`

**Interfaces:**
- Produces: HTTP 服务监听 `:8080`，`GET /healthz` → 200 "ok"。
- Produces: `Config` 结构（`config.go`），字段 `DBHost/DBPort/DBUser/DBPassword/DBName string`；`LoadConfig() Config` 从环境变量读取。

- [ ] **Step 1: 建 go.mod**

`services/profile-service/go.mod`：
```
module profile-service

go 1.22

require github.com/go-sql-driver/mysql v1.8.1
```

- [ ] **Step 2: 写 config.go**

```go
package main

import "os"

type Config struct {
	DBHost     string
	DBPort     string
	DBUser     string
	DBPassword string
	DBName     string
}

func LoadConfig() Config {
	return Config{
		DBHost:     os.Getenv("DB_HOST"),
		DBPort:     getenv("DB_PORT", "3306"),
		DBUser:     os.Getenv("DB_USER"),
		DBPassword: os.Getenv("DB_PASSWORD"),
		DBName:     os.Getenv("DB_NAME"),
	}
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
```

- [ ] **Step 3: 写最小 main.go（先只有 /healthz）**

```go
package main

import (
	"log"
	"net/http"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	log.Println("profile-service listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}
```

- [ ] **Step 4: 本地跑通 /healthz**

```bash
cd playground/services/profile-service
go mod tidy
go run . &
sleep 1
curl -s localhost:8080/healthz    # 期望: ok
kill %1
```
Expected: `curl` 打印 `ok`。

- [ ] **Step 5: 提交**

```bash
cd playground
git add services/profile-service/go.mod services/profile-service/go.sum services/profile-service/main.go services/profile-service/config.go
git commit -m "feat(profile-service): go skeleton with healthz"
```

---

## Task 2: 域模型 + mapper（纯函数 TDD）

**Files:**
- Create: `services/profile-service/models.go`, `mapper.go`, `mapper_test.go`

**Interfaces:**
- Produces: `GithubUser`（GitHub `/user` 响应字段）、`Profile`（DB 行）、`SearchFilter` 结构。
- Produces: `ToRow(u GithubUser) Profile` —— 纯映射函数。

- [ ] **Step 1: 写 models.go**

```go
package main

type GithubUser struct {
	ID          int64  `json:"id"`
	Login       string `json:"login"`
	Name        string `json:"name"`
	AvatarURL   string `json:"avatar_url"`
	Bio         string `json:"bio"`
	Company     string `json:"company"`
	Location    string `json:"location"`
	PublicRepos int    `json:"public_repos"`
	Followers   int    `json:"followers"`
	Following   int    `json:"following"`
	CreatedAt   string `json:"created_at"`
}

type Profile struct {
	ID              int64  `json:"id"`
	GithubID        int64  `json:"github_id"`
	Login           string `json:"login"`
	Name            string `json:"name"`
	AvatarURL       string `json:"avatar_url"`
	Bio             string `json:"bio"`
	Company         string `json:"company"`
	Location        string `json:"location"`
	PublicRepos     int    `json:"public_repos"`
	Followers       int    `json:"followers"`
	Following       int    `json:"following"`
	GithubCreatedAt string `json:"github_created_at"`
}

type SearchFilter struct {
	Q            string // login/name 模糊
	Location     string // location 模糊
	MinFollowers int
}
```

- [ ] **Step 2: 写失败的测试 mapper_test.go**

```go
package main

import "testing"

func TestToRow(t *testing.T) {
	u := GithubUser{
		ID: 583231, Login: "octocat", Name: "The Octocat",
		AvatarURL: "https://a/u/583231", Bio: "hi", Company: "@github",
		Location: "SF", PublicRepos: 8, Followers: 100, Following: 9,
		CreatedAt: "2011-01-25T18:44:36Z",
	}
	got := ToRow(u)
	if got.GithubID != 583231 || got.Login != "octocat" {
		t.Fatalf("core fields wrong: %+v", got)
	}
	if got.GithubCreatedAt != "2011-01-25 18:44:36" {
		t.Fatalf("created_at not normalized: %q", got.GithubCreatedAt)
	}
}

func TestToRowEmptyCreatedAt(t *testing.T) {
	got := ToRow(GithubUser{ID: 1, Login: "a"})
	if got.GithubCreatedAt != "" {
		t.Fatalf("want empty, got %q", got.GithubCreatedAt)
	}
}
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd playground/services/profile-service
go test ./...
```
Expected: FAIL（`undefined: ToRow`）。

- [ ] **Step 4: 写 mapper.go**

```go
package main

import "strings"

func ToRow(u GithubUser) Profile {
	created := ""
	if u.CreatedAt != "" {
		created = strings.Replace(strings.Replace(u.CreatedAt, "T", " ", 1), "Z", "", 1)
	}
	return Profile{
		GithubID: u.ID, Login: u.Login, Name: u.Name, AvatarURL: u.AvatarURL,
		Bio: u.Bio, Company: u.Company, Location: u.Location,
		PublicRepos: u.PublicRepos, Followers: u.Followers, Following: u.Following,
		GithubCreatedAt: created,
	}
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
go test ./...
```
Expected: `ok  profile-service`（2 tests pass）。

- [ ] **Step 6: 提交**

```bash
cd playground
git add services/profile-service/models.go services/profile-service/mapper.go services/profile-service/mapper_test.go
git commit -m "feat(profile-service): domain models and profile mapper with tests"
```

---

## Task 3: DB 层（建表 / upsert / list-search / get）

**Files:**
- Create: `services/profile-service/store.go`

**Interfaces:**
- Consumes: `Config`、`Profile`、`SearchFilter`。
- Produces: `Store` 结构；`NewStore(cfg Config) (*Store, error)`；`(*Store) EnsureSchemaWithRetry(attempts int, wait time.Duration) error`；`Upsert(Profile) (Profile, error)`；`List(SearchFilter) ([]Profile, error)`；`GetByID(int64) (*Profile, error)`；`Close()`。

- [ ] **Step 1: 写 store.go**

```go
package main

import (
	"database/sql"
	"fmt"
	"log"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

type Store struct{ db *sql.DB }

func NewStore(cfg Config) (*Store, error) {
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?parseTime=true&timeout=5s",
		cfg.DBUser, cfg.DBPassword, cfg.DBHost, cfg.DBPort, cfg.DBName)
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	db.SetConnMaxLifetime(5 * time.Minute)
	db.SetMaxOpenConns(10)
	return &Store{db: db}, nil
}

func (s *Store) Close() { _ = s.db.Close() }

const schema = `CREATE TABLE IF NOT EXISTS profiles (
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
  github_created_at DATETIME NULL,
  stored_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`

// EnsureSchemaWithRetry 等 RDS 就绪并建表（apply 时 RDS 可能还在创建）
func (s *Store) EnsureSchemaWithRetry(attempts int, wait time.Duration) error {
	var err error
	for i := 0; i < attempts; i++ {
		if err = s.db.Ping(); err == nil {
			if _, err = s.db.Exec(schema); err == nil {
				return nil
			}
		}
		log.Printf("db not ready (%d/%d): %v", i+1, attempts, err)
		time.Sleep(wait)
	}
	return err
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (s *Store) Upsert(p Profile) (Profile, error) {
	_, err := s.db.Exec(`INSERT INTO profiles
      (github_id, login, name, avatar_url, bio, company, location,
       public_repos, followers, following, github_created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       login=VALUES(login), name=VALUES(name), avatar_url=VALUES(avatar_url),
       bio=VALUES(bio), company=VALUES(company), location=VALUES(location),
       public_repos=VALUES(public_repos), followers=VALUES(followers),
       following=VALUES(following), github_created_at=VALUES(github_created_at)`,
		p.GithubID, p.Login, nullStr(p.Name), nullStr(p.AvatarURL), nullStr(p.Bio),
		nullStr(p.Company), nullStr(p.Location), p.PublicRepos, p.Followers,
		p.Following, nullStr(p.GithubCreatedAt))
	if err != nil {
		return Profile{}, err
	}
	rows, err := s.query("SELECT * FROM profiles WHERE github_id=?", p.GithubID)
	if err != nil {
		return Profile{}, err
	}
	if len(rows) == 0 {
		return Profile{}, fmt.Errorf("upsert: row not found after insert")
	}
	return rows[0], nil
}

func (s *Store) List(f SearchFilter) ([]Profile, error) {
	q := "SELECT * FROM profiles WHERE 1=1"
	var args []any
	if f.Q != "" {
		q += " AND (login LIKE ? OR name LIKE ?)"
		like := "%" + f.Q + "%"
		args = append(args, like, like)
	}
	if f.Location != "" {
		q += " AND location LIKE ?"
		args = append(args, "%"+f.Location+"%")
	}
	if f.MinFollowers > 0 {
		q += " AND followers >= ?"
		args = append(args, f.MinFollowers)
	}
	q += " ORDER BY id DESC LIMIT 100"
	return s.query(q, args...)
}

func (s *Store) GetByID(id int64) (*Profile, error) {
	rows, err := s.query("SELECT * FROM profiles WHERE id=?", id)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return &rows[0], nil
}

// query 把结果扫描进 []Profile
func (s *Store) query(q string, args ...any) ([]Profile, error) {
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Profile
	for rows.Next() {
		var p Profile
		var name, avatar, bio, company, location, created sql.NullString
		var storedAt sql.NullString
		if err := rows.Scan(&p.ID, &p.GithubID, &p.Login, &name, &avatar, &bio,
			&company, &location, &p.PublicRepos, &p.Followers, &p.Following,
			&created, &storedAt); err != nil {
			return nil, err
		}
		p.Name, p.AvatarURL, p.Bio = name.String, avatar.String, bio.String
		p.Company, p.Location, p.GithubCreatedAt = company.String, location.String, strings.TrimSpace(created.String)
		out = append(out, p)
	}
	return out, rows.Err()
}
```

- [ ] **Step 2: 编译检查**

```bash
cd playground/services/profile-service
go mod tidy
go build ./...
```
Expected: 编译通过，无报错。

- [ ] **Step 3: 提交**

```bash
cd playground
git add services/profile-service/store.go services/profile-service/go.mod services/profile-service/go.sum
git commit -m "feat(profile-service): mysql store with schema init, upsert, search, get"
```

---

## Task 4: GitHub 客户端 + handlers + 路由接线

**Files:**
- Create: `services/profile-service/github.go`, `handler.go`
- Modify: `services/profile-service/main.go`

**Interfaces:**
- Produces: `FetchUser(token string) (GithubUser, int, error)` —— 返回用户、HTTP 状态码、错误。
- Produces: `Handler{store *Store}`；`CreateProfile/ListProfiles/GetProfile(w, r)`。

- [ ] **Step 1: 写 github.go**

```go
package main

import (
	"encoding/json"
	"net/http"
	"time"
)

func FetchUser(token string) (GithubUser, int, error) {
	req, _ := http.NewRequest("GET", "https://api.github.com/user", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "github-profile-collector")
	client := &http.Client{Timeout: 10 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return GithubUser{}, 0, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return GithubUser{}, res.StatusCode, nil
	}
	var u GithubUser
	if err := json.NewDecoder(res.Body).Decode(&u); err != nil {
		return GithubUser{}, res.StatusCode, err
	}
	return u, 200, nil
}
```

- [ ] **Step 2: 写 handler.go**

```go
package main

import (
	"encoding/json"
	"net/http"
	"strconv"
)

type Handler struct{ store *Store }

func NewHandler(s *Store) *Handler { return &Handler{store: s} }

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (h *Handler) CreateProfile(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Token == "" {
		writeJSON(w, 400, map[string]string{"error": "token is required"})
		return
	}
	u, status, err := FetchUser(body.Token)
	if err != nil {
		writeJSON(w, 502, map[string]string{"error": "github api error"})
		return
	}
	if status == 401 {
		writeJSON(w, 401, map[string]string{"error": "invalid github token"})
		return
	}
	if status != 200 {
		writeJSON(w, 502, map[string]string{"error": "github api error"})
		return
	}
	saved, err := h.store.Upsert(ToRow(u))
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "db error"})
		return
	}
	writeJSON(w, 201, saved)
}

func (h *Handler) ListProfiles(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	minF, _ := strconv.Atoi(q.Get("minFollowers"))
	f := SearchFilter{Q: q.Get("q"), Location: q.Get("location"), MinFollowers: minF}
	list, err := h.store.List(f)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "db error"})
		return
	}
	if list == nil {
		list = []Profile{}
	}
	writeJSON(w, 200, list)
}

func (h *Handler) GetProfile(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad id"})
		return
	}
	p, err := h.store.GetByID(id)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "db error"})
		return
	}
	if p == nil {
		writeJSON(w, 404, map[string]string{"error": "profile not found"})
		return
	}
	writeJSON(w, 200, p)
}
```

- [ ] **Step 3: 更新 main.go 接线**

`services/profile-service/main.go` 全文替换为：
```go
package main

import (
	"log"
	"net/http"
	"time"
)

func main() {
	cfg := LoadConfig()
	store, err := NewStore(cfg)
	if err != nil {
		log.Fatalf("store init: %v", err)
	}
	defer store.Close()

	// 后台等 RDS 就绪并建表，不阻塞 HTTP 启动 → /healthz 立即可用、ALB 快速 healthy
	go func() {
		if err := store.EnsureSchemaWithRetry(120, 5*time.Second); err != nil {
			log.Printf("WARN ensure schema failed: %v", err)
			return
		}
		log.Println("schema ready")
	}()

	h := NewHandler(store)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("POST /profiles", h.CreateProfile)
	mux.HandleFunc("GET /profiles", h.ListProfiles)
	mux.HandleFunc("GET /profiles/{id}", h.GetProfile)

	log.Println("profile-service listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}
```

- [ ] **Step 4: 编译**

```bash
cd playground/services/profile-service
go build ./... && go test ./...
```
Expected: build 通过；测试仍 2 pass。

- [ ] **Step 5: 提交**

```bash
cd playground
git add services/profile-service/github.go services/profile-service/handler.go services/profile-service/main.go
git commit -m "feat(profile-service): github client, http handlers, routes"
```

---

## Task 5: Dockerfile + 本地 docker-compose 全链路联调

**Files:**
- Create: `services/profile-service/Dockerfile`, `services/profile-service/compose.yaml`, `services/profile-service/.dockerignore`

**目标**：多阶段构建镜像，本地用 docker-compose 起 MySQL + 服务，验证建/列/查全流程（**免费、不碰 AWS**）。

- [ ] **Step 1: 写 Dockerfile**

```dockerfile
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /profile-service .

FROM gcr.io/distroless/static-debian12
COPY --from=build /profile-service /profile-service
EXPOSE 8080
ENTRYPOINT ["/profile-service"]
```

- [ ] **Step 2: 写 .dockerignore**

```
compose.yaml
*_test.go
```

- [ ] **Step 3: 写 compose.yaml（仅本地联调用）**

```yaml
services:
  db:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: rootpw
      MYSQL_DATABASE: profiles_app
      MYSQL_USER: appuser
      MYSQL_PASSWORD: apppw
    ports: ["3306:3306"]
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-prootpw"]
      interval: 3s
      retries: 20
  app:
    build: .
    environment:
      DB_HOST: db
      DB_PORT: "3306"
      DB_USER: appuser
      DB_PASSWORD: apppw
      DB_NAME: profiles_app
    ports: ["8080:8080"]
    depends_on:
      db:
        condition: service_healthy
```

- [ ] **Step 4: 起容器并联调**

```bash
cd playground/services/profile-service
docker compose up --build -d
sleep 8
curl -s localhost:8080/healthz                       # ok
curl -s -X POST localhost:8080/profiles \
  -H 'Content-Type: application/json' \
  -d '{"token":"你的GitHub_token"}'                  # 期望 201 + 你的 profile
curl -s localhost:8080/profiles                      # 期望列表含你
curl -s "localhost:8080/profiles?q=你的login"        # 期望搜到
curl -s localhost:8080/profiles/1                    # 期望详情
docker compose down -v
```
**验证**：POST 返回 201 + profile；列表/搜索/详情正确。

- [ ] **Step 5: 提交**

```bash
cd playground
git add services/profile-service/Dockerfile services/profile-service/.dockerignore services/profile-service/compose.yaml
git commit -m "feat(profile-service): dockerfile and local compose integration"
```

---

## Task 6: Terraform —— ECS 角色 + 日志组

**Files:**
- Create: `infra/iam-ecs.tf`

**Interfaces:**
- Produces: `aws_iam_role.ecs_execution`（拉 ECR/写日志/读 Secrets）、`aws_iam_role.ecs_task`（应用角色，本阶段最小）、`aws_cloudwatch_log_group.profile`。

- [ ] **Step 1: 写 infra/iam-ecs.tf**

```hcl
resource "aws_cloudwatch_log_group" "profile" {
  name              = "/ecs/${local.name_prefix}-profile-service"
  retention_in_days = 3
}

# 执行角色：ECS 代理用来拉镜像、写日志、注入 secrets
resource "aws_iam_role" "ecs_execution" {
  name = "${local.name_prefix}-ecs-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution_managed" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# 允许执行角色读取 DB 密钥（注入容器环境变量）
resource "aws_iam_role_policy" "ecs_execution_secrets" {
  name = "${local.name_prefix}-ecs-exec-secrets"
  role = aws_iam_role.ecs_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = aws_secretsmanager_secret.db.arn
    }]
  })
}

# 任务角色：应用自身的 AWS 权限（本阶段 profile-service 不调 AWS API，留空占位）
resource "aws_iam_role" "ecs_task" {
  name = "${local.name_prefix}-ecs-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}
```

- [ ] **Step 2: 校验**

```bash
cd playground/infra
terraform fmt && terraform validate && terraform plan
```
Expected: 新增 log group + 2 角色 + 1 附加 + 1 内联策略；无报错。（不 apply）

- [ ] **Step 3: 提交**

```bash
cd playground
git add infra/iam-ecs.tf
git commit -m "infra: ecs execution/task roles and cloudwatch log group"
```

---

## Task 7: Terraform —— profile-service 任务定义 + 服务 + Cloud Map

**Files:**
- Create: `infra/ecs-profile.tf`

**Interfaces:**
- Consumes: `ecs_cluster`、`private_subnet`、`profile_svc` SG、`profile` 目标组、`cloudmap` 命名空间、`ecr_profile`、`db_secret`、执行/任务角色、日志组。
- Produces: `aws_ecs_service.profile`、`aws_service_discovery_service.profile`（`profile.svc.internal`）。

- [ ] **Step 1: 写 infra/ecs-profile.tf**

```hcl
resource "aws_service_discovery_service" "profile" {
  name = "profile"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main.id
    dns_records {
      type = "A"
      ttl  = 10
    }
    routing_policy = "MULTIVALUE"
  }
  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_ecs_task_definition" "profile" {
  family                   = "${local.name_prefix}-profile"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name      = "profile-service"
    image     = "${aws_ecr_repository.profile.repository_url}:latest"
    essential = true
    portMappings = [{ containerPort = 8080, protocol = "tcp" }]
    environment = [
      { name = "DB_PORT", value = "3306" }
    ]
    secrets = [
      { name = "DB_HOST", valueFrom = "${aws_secretsmanager_secret.db.arn}:host::" },
      { name = "DB_USER", valueFrom = "${aws_secretsmanager_secret.db.arn}:username::" },
      { name = "DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.db.arn}:password::" },
      { name = "DB_NAME", valueFrom = "${aws_secretsmanager_secret.db.arn}:dbname::" }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.profile.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "profile"
      }
    }
  }])
}

resource "aws_ecs_service" "profile" {
  name            = "${local.name_prefix}-profile"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.profile.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  # 给容器等 RDS 就绪的时间，避免启动初期 ALB unhealthy 就被 ECS 替换
  health_check_grace_period_seconds = 120

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.profile_svc.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.profile.arn
    container_name   = "profile-service"
    container_port   = 8080
  }

  service_registries {
    registry_arn = aws_service_discovery_service.profile.arn
  }

  # 首次部署镜像可能还没 push，容忍任务反复重启直到镜像就绪
  depends_on = [aws_lb_listener.http]
}
```

- [ ] **Step 2: 校验**

```bash
cd playground/infra
terraform fmt && terraform validate && terraform plan
```
Expected: 新增 Cloud Map service + task definition + ecs service；无报错。

- [ ] **Step 3: 提交**

```bash
cd playground
git add infra/ecs-profile.tf
git commit -m "infra: profile-service task definition, ecs service, cloud map registration"
```

---

## Task 8: Lambda BFF（Node 转发）+ Terraform（Lambda-in-VPC + API Gateway）

**Files:**
- Create: `bff/index.mjs`, `bff/package.json`, `infra/bff.tf`

**Interfaces:**
- Produces: Lambda handler 转发 `POST/GET /profiles`、`GET /profiles/{id}` 到内网 ALB。
- Produces: `aws_apigatewayv2_api` 公网入口（output `bff_api_url`）。

- [ ] **Step 1: 写 bff/index.mjs**

```javascript
// BFF：把 API Gateway 请求转发到内网 ALB 的 profile-service，不碰 DB
const ALB_URL = process.env.ALB_URL; // 形如 http://internal-...elb.amazonaws.com

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const path = event.rawPath || "/";
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `${ALB_URL}${path}${qs}`;

  const init = { method, headers: { "Content-Type": "application/json" } };
  if (event.body) init.body = event.body;

  try {
    const res = await fetch(url, init);
    const text = await res.text();
    return {
      statusCode: res.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
      body: text,
    };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: "bff upstream error" }) };
  }
};
```

- [ ] **Step 2: 写 bff/package.json**

```json
{
  "name": "profile-bff",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "index.mjs"
}
```

- [ ] **Step 3: 写 infra/bff.tf**

```hcl
# 打包 BFF 代码为 zip（无依赖，内置 fetch）
data "archive_file" "bff" {
  type        = "zip"
  source_dir  = "${path.module}/../bff"
  output_path = "${path.module}/bff.zip"
}

resource "aws_iam_role" "bff" {
  name = "${local.name_prefix}-bff"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# VPC 内运行需要网卡权限
resource "aws_iam_role_policy_attachment" "bff_vpc" {
  role       = aws_iam_role.bff.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_lambda_function" "bff" {
  function_name    = "${local.name_prefix}-bff"
  role             = aws_iam_role.bff.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.bff.output_path
  source_code_hash = data.archive_file.bff.output_base64sha256
  timeout          = 15

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }
  environment {
    variables = { ALB_URL = "http://${aws_lb.main.dns_name}" }
  }
}

# API Gateway HTTP API
resource "aws_apigatewayv2_api" "bff" {
  name          = "${local.name_prefix}-bff-api"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "OPTIONS"]
    allow_headers = ["content-type"]
  }
}

resource "aws_apigatewayv2_integration" "bff" {
  api_id                 = aws_apigatewayv2_api.bff.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.bff.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "routes" {
  for_each  = toset(["POST /profiles", "GET /profiles", "GET /profiles/{id}"])
  api_id    = aws_apigatewayv2_api.bff.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.bff.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.bff.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGW"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.bff.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.bff.execution_arn}/*/*"
}

output "bff_api_url" { value = aws_apigatewayv2_stage.default.invoke_url }
```

- [ ] **Step 4: 在 versions.tf 声明 archive provider**

`archive_file` 需要 `hashicorp/archive` provider。在 `infra/versions.tf` 的 `required_providers` 块里追加：
```hcl
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4"
    }
```

- [ ] **Step 5: 重新 init 并校验**

```bash
cd playground/infra
terraform init   # 安装 archive provider
terraform fmt && terraform validate && terraform plan
```
Expected: 新增 Lambda + 角色 + API + 集成 + 3 路由 + stage + permission；无报错。

- [ ] **Step 6: 提交**

```bash
cd playground
git add bff/index.mjs bff/package.json infra/bff.tf infra/versions.tf
git commit -m "feat(bff): node forwarder lambda in vpc + api gateway"
```

---

## Task 9: 上云部署 + 全链路集成测试 + destroy

**目标**：apply 建全套、push 镜像、跑起 profile-service、经 API Gateway 端到端验证、然后 destroy。⚠️ 本任务花钱（~$0.15/小时），验证完必须 destroy。

- [ ] **Step 1: 先建 ECR（供 push 镜像）**

```bash
cd playground/infra
terraform workspace select test
terraform apply -target=aws_ecr_repository.profile   # yes
terraform output -raw ecr_profile_url                 # 记下仓库地址
```

- [ ] **Step 2: 构建并推送镜像**

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=ap-southeast-1
REPO=$(cd playground/infra && terraform output -raw ecr_profile_url)
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
cd playground/services/profile-service
docker build --platform linux/amd64 -t "$REPO:latest" .
docker push "$REPO:latest"
```
**验证**：`aws ecr list-images --repository-name profile-test-profile-service --region $REGION` 里有 `latest`。
> ⚠️ Fargate 是 x86，务必 `--platform linux/amd64`（Mac M 芯片默认 arm64 会导致任务起不来）。

- [ ] **Step 3: apply 全套**

```bash
cd playground/infra
terraform apply     # yes（RDS 约 5-10 分钟；ECS 服务会拉刚 push 的镜像）
terraform output    # 记下 bff_api_url、alb_dns_name
```
> 若 apply 中途令牌过期，刷新凭证后再 `terraform apply` 续跑（幂等）。

- [ ] **Step 4: 等服务健康**

```bash
# 等 ECS 任务 RUNNING + 目标组 healthy（约 1-3 分钟）
aws ecs describe-services --cluster profile-test-cluster \
  --services profile-test-profile --region ap-southeast-1 \
  --query 'services[0].{running:runningCount,desired:desiredCount}'
# 期望 running=1 desired=1
```
若 running 长期为 0：看日志 `aws logs tail /ecs/profile-test-profile-service --region ap-southeast-1 --since 5m`（常见：镜像架构错、DB 未就绪重试中）。必要时 `aws ecs update-service --cluster profile-test-cluster --service profile-test-profile --force-new-deployment --region ap-southeast-1`。

- [ ] **Step 5: 经 API Gateway 端到端测试**

```bash
API=$(cd playground/infra && terraform output -raw bff_api_url)
curl -s "$API/profiles"                                   # 期望 []
curl -s -X POST "$API/profiles" -H 'Content-Type: application/json' \
  -d '{"token":"你的GitHub_token"}'                       # 期望 201 + profile
curl -s "$API/profiles"                                   # 期望列表含你
curl -s "$API/profiles?q=你的login"                       # 期望搜到
curl -s "$API/profiles/1"                                 # 期望详情
```
**验证（全链路通电）**：公网 → API Gateway → BFF(VPC) → 内网 ALB → profile-service(Fargate) → 私网 RDS，建/列/查/搜全部正确。

- [ ] **Step 6: destroy（停止计费）**

```bash
cd playground/infra
terraform destroy   # yes
```
**验证**：`Destroy complete!`；控制台确认 NAT/RDS/ECS/ALB 均消失。

- [ ] **Step 7: 推送代码**

```bash
cd playground
git push origin HEAD:main
# 回 brain 更新 submodule 指针
cd ../.. && git add aws-learning/playground && git commit -m "chore: bump submodule (Plan 2 profile-service)" && git push
```

---

## 自检：spec 覆盖核对（Plan 2 范围）

- profile-service(Go) 拥有 profiles 表、抓 GitHub、CRUD+搜索 → Task 2/3/4 ✅
- /healthz 存活探测不查 DB → Task 1/4 ✅
- DB 连接从 Secrets Manager 注入 → Task 7 ✅
- token 透传即弃不入库 → Task 4 ✅
- 容器化 + 本地联调 → Task 5 ✅
- Fargate 服务 + 挂 ALB 目标组 + Cloud Map 注册 → Task 7 ✅
- Lambda BFF 纯转发、在 VPC、不碰 DB → Task 8 ✅
- API Gateway 公网入口 → Task 8 ✅
- 全链路端到端验证 → Task 9 ✅
- IaC 建/拆省钱 → Task 9 ✅
- stats-service / 榜单 / 前端新页面 → **属 Plan 3+，本计划不含**（范围正确）

## 交接给 Plan 3

- stats-service 将经 Cloud Map 调 `profile.svc.internal`（Task 7 已注册）。
- BFF 将扩展聚合 stats 响应；ALB 的 `/leaderboard`、`/*/stats`、`/*/repos` 规则（Plan 1 已建）届时指向 stats 目标组。
