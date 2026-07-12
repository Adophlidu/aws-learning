# 架构改造 Plan 3：stats-service(Go) + Cloud Map 东西向 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **学习项目说明**：教练手册。Claude 写代码，用户亲手跑 `terraform`/`docker`/`aws`/`go` 命令并去控制台看。纯逻辑 TDD（免费）；本地 compose 联调（免费）；上云集成才 apply（花钱），验证完 destroy。

**Goal:** 加第二个 Go 领域服务 **stats-service**（仓库+语言统计+榜单），核心是让它**经 Cloud Map 调 profile-service**（`profile.svc.internal`）拿展示信息拼榜单——东西向服务发现真正落地；BFF 升级为编排器（创建时 fan-out 到两个服务）。

**Architecture:** stats-service 拥有 `repos` 表，抓 GitHub `/user/repos`，用聚合 SQL 出语言统计和榜单；榜单经 **Cloud Map** 调 profile-service 的新 `/internal/profiles` 批量接口取 login/name/avatar。BFF 在 `POST /profiles` 时先调 profile-service 存档、再调 stats-service 采集。ALB 按路径把 `/stats /repos /leaderboard /collect` 路由到 stats 目标组。

**Tech Stack:** Go 1.24、`go-sql-driver/mysql`、聚合 SQL（GROUP BY）、Cloud Map 私有 DNS 服务发现、Docker、Node BFF 编排、Terraform（ECS 服务、ALB 规则调整、API Gateway 路由扩展）。

## Global Constraints

- 区域 **ap-southeast-1**；命名前缀 `local.name_prefix`。
- stats-service 监听 **8080**，`GET /healthz` 不查 DB；DB 连接从 Secrets Manager 注入；token 透传即弃。
- stats 数据一律按 **github_id** 关联（跨服务稳定键）；stats **不碰 profiles 表**，要 profile 数据一律经 Cloud Map 调 profile-service。
- 沿用 Plan 1/2 已建资源；stats-service 复用 Plan 1 的 `ecr_stats`、`stats` 目标组、`stats_svc` SG（Plan 1 已放行 stats→profile 8080）。
- 依据设计：`playground/docs/2026-07-12-architecture-overhaul-design.md`。
- 上云验证后 `terraform destroy`。

---

## 文件结构

```
playground/
├── services/stats-service/         ← 新增 Go 服务
│   ├── go.mod / config.go / models.go / mapper.go / mapper_test.go
│   ├── github.go        # 抓 /user/repos
│   ├── profileclient.go # 经 Cloud Map 调 profile-service (东西向)
│   ├── store.go         # repos 表 + 聚合查询(stats/leaderboard)
│   ├── handler.go       # /collect /stats/{gid} /repos/{gid} /leaderboard
│   ├── main.go / Dockerfile / compose.yaml / .dockerignore
├── services/profile-service/
│   ├── handler.go       ← 改：加 InternalList (按 github_id 批量查)
│   └── main.go          ← 改：加路由 GET /internal/profiles
├── bff/index.mjs                   ← 改：POST /profiles 编排两个服务
└── infra/
    ├── ecs-stats.tf     ← 新增：stats 任务定义 + 服务
    ├── alb.tf           ← 改：路径规则调整为 /stats/* /repos/* /leaderboard* /collect
    └── bff.tf           ← 改：API Gateway 加 /stats /repos /leaderboard 路由
```

---

## Task 1: stats-service Go 骨架

**Files:**
- Create: `services/stats-service/go.mod`, `config.go`, `main.go`

**Interfaces:**
- Produces: HTTP `:8080`，`GET /healthz` → 200；`Config`（同 profile-service 字段）+ `PROFILE_SVC_URL`（Cloud Map 地址）。

- [ ] **Step 1: go.mod**

```
module stats-service

go 1.24

require github.com/go-sql-driver/mysql v1.10.0
```

- [ ] **Step 2: config.go**

```go
package main

import "os"

type Config struct {
	DBHost, DBPort, DBUser, DBPassword, DBName string
	ProfileSvcURL                              string // 经 Cloud Map: http://profile.svc.internal:8080
}

func LoadConfig() Config {
	return Config{
		DBHost:        os.Getenv("DB_HOST"),
		DBPort:        getenv("DB_PORT", "3306"),
		DBUser:        os.Getenv("DB_USER"),
		DBPassword:    os.Getenv("DB_PASSWORD"),
		DBName:        os.Getenv("DB_NAME"),
		ProfileSvcURL: getenv("PROFILE_SVC_URL", "http://profile.svc.internal:8080"),
	}
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
```

- [ ] **Step 3: main.go（先只 /healthz）**

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
	log.Println("stats-service listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}
```

- [ ] **Step 4: 本地跑通**

```bash
cd playground/services/stats-service
go mod tidy
go run . &
sleep 1
curl -s localhost:8080/healthz && echo
kill %1
```
Expected: `ok`。

- [ ] **Step 5: 提交**

```bash
cd playground
git add services/stats-service/go.mod services/stats-service/go.sum services/stats-service/config.go services/stats-service/main.go
git commit -m "feat(stats-service): go skeleton with healthz"
```

---

## Task 2: 模型 + repo mapper（TDD）

**Files:**
- Create: `services/stats-service/models.go`, `mapper.go`, `mapper_test.go`

**Interfaces:**
- Produces: `GithubRepo`（GitHub repos 项）、`RepoRow`（DB 行）、`LangStat`、`LeaderboardEntry`。
- Produces: `ToRepoRow(githubID int64, r GithubRepo) RepoRow` —— 纯映射。

- [ ] **Step 1: models.go**

```go
package main

type GithubRepo struct {
	Name       string `json:"name"`
	Language   string `json:"language"`
	Stargazers int    `json:"stargazers_count"`
	UpdatedAt  string `json:"updated_at"`
}

type RepoRow struct {
	GithubID   int64  `json:"github_id"`
	RepoName   string `json:"repo_name"`
	Language   string `json:"language"`
	Stargazers int    `json:"stargazers_count"`
	UpdatedAt  string `json:"updated_at"`
}

type LangStat struct {
	Language  string `json:"language"`
	RepoCount int    `json:"repo_count"`
	StarSum   int    `json:"star_sum"`
}

type LeaderboardEntry struct {
	GithubID   int64  `json:"github_id"`
	Login      string `json:"login"`
	Name       string `json:"name"`
	AvatarURL  string `json:"avatar_url"`
	TotalStars int    `json:"total_stars"`
	TotalRepos int    `json:"total_repos"`
}
```

- [ ] **Step 2: 失败测试 mapper_test.go**

```go
package main

import "testing"

func TestToRepoRow(t *testing.T) {
	r := GithubRepo{Name: "hello", Language: "Go", Stargazers: 42, UpdatedAt: "2024-01-02T03:04:05Z"}
	got := ToRepoRow(583231, r)
	if got.GithubID != 583231 || got.RepoName != "hello" || got.Language != "Go" || got.Stargazers != 42 {
		t.Fatalf("wrong: %+v", got)
	}
	if got.UpdatedAt != "2024-01-02 03:04:05" {
		t.Fatalf("updated_at not normalized: %q", got.UpdatedAt)
	}
}

func TestToRepoRowNoLanguage(t *testing.T) {
	got := ToRepoRow(1, GithubRepo{Name: "x"})
	if got.Language != "" {
		t.Fatalf("want empty language, got %q", got.Language)
	}
}
```

- [ ] **Step 3: 运行确认失败**

```bash
cd playground/services/stats-service
go test ./...
```
Expected: FAIL（`undefined: ToRepoRow`）。

- [ ] **Step 4: mapper.go**

```go
package main

import "strings"

func ToRepoRow(githubID int64, r GithubRepo) RepoRow {
	updated := ""
	if r.UpdatedAt != "" {
		updated = strings.Replace(strings.Replace(r.UpdatedAt, "T", " ", 1), "Z", "", 1)
	}
	return RepoRow{
		GithubID:   githubID,
		RepoName:   r.Name,
		Language:   r.Language,
		Stargazers: r.Stargazers,
		UpdatedAt:  updated,
	}
}
```

- [ ] **Step 5: 运行确认通过**

```bash
go test ./...
```
Expected: 2 pass。

- [ ] **Step 6: 提交**

```bash
cd playground
git add services/stats-service/models.go services/stats-service/mapper.go services/stats-service/mapper_test.go
git commit -m "feat(stats-service): models and repo mapper with tests"
```

---

## Task 3: DB 层（repos 表 + 聚合查询）

**Files:**
- Create: `services/stats-service/store.go`

**Interfaces:**
- Produces: `Store`；`NewStore(Config)`；`EnsureSchemaWithRetry(int, time.Duration)`；`ReplaceRepos(githubID int64, rows []RepoRow) error`（先删该用户旧 repos 再插新）；`StatsByUser(githubID int64) ([]LangStat, error)`；`ReposByUser(githubID int64) ([]RepoRow, error)`；`Leaderboard(by string, limit int) ([]LeaderboardEntry, error)`（只填 github_id/stars/repos，展示字段留空由 handler 经 Cloud Map 补）；`Close()`。

- [ ] **Step 1: store.go**

```go
package main

import (
	"database/sql"
	"fmt"
	"log"
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

const schema = `CREATE TABLE IF NOT EXISTS repos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  github_id BIGINT NOT NULL,
  repo_name VARCHAR(255) NOT NULL,
  language VARCHAR(100),
  stargazers_count INT DEFAULT 0,
  updated_at DATETIME NULL,
  UNIQUE KEY uq_owner_repo (github_id, repo_name),
  INDEX idx_github_id (github_id)
)`

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

// ReplaceRepos 先删该用户旧 repos 再批量插新（一个用户的仓库是一次性刷新的）
func (s *Store) ReplaceRepos(githubID int64, rows []RepoRow) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("DELETE FROM repos WHERE github_id=?", githubID); err != nil {
		return err
	}
	for _, r := range rows {
		if _, err = tx.Exec(
			"INSERT INTO repos (github_id, repo_name, language, stargazers_count, updated_at) VALUES (?,?,?,?,?)",
			r.GithubID, r.RepoName, nullStr(r.Language), r.Stargazers, nullStr(r.UpdatedAt)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) StatsByUser(githubID int64) ([]LangStat, error) {
	rows, err := s.db.Query(`SELECT COALESCE(language,'Unknown') lang, COUNT(*) c, COALESCE(SUM(stargazers_count),0) s
	  FROM repos WHERE github_id=? GROUP BY lang ORDER BY s DESC`, githubID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LangStat
	for rows.Next() {
		var l LangStat
		if err := rows.Scan(&l.Language, &l.RepoCount, &l.StarSum); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func (s *Store) ReposByUser(githubID int64) ([]RepoRow, error) {
	rows, err := s.db.Query(`SELECT github_id, repo_name, COALESCE(language,''), stargazers_count, COALESCE(updated_at,'')
	  FROM repos WHERE github_id=? ORDER BY stargazers_count DESC LIMIT 100`, githubID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RepoRow
	for rows.Next() {
		var r RepoRow
		if err := rows.Scan(&r.GithubID, &r.RepoName, &r.Language, &r.Stargazers, &r.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Leaderboard 按 stars 或 repos 排名；只填 github_id/stars/repos，展示字段由 handler 经 Cloud Map 补
func (s *Store) Leaderboard(by string, limit int) ([]LeaderboardEntry, error) {
	order := "total_stars"
	if by == "repos" {
		order = "total_repos"
	}
	q := fmt.Sprintf(`SELECT github_id, COALESCE(SUM(stargazers_count),0) total_stars, COUNT(*) total_repos
	  FROM repos GROUP BY github_id ORDER BY %s DESC LIMIT ?`, order)
	rows, err := s.db.Query(q, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LeaderboardEntry
	for rows.Next() {
		var e LeaderboardEntry
		if err := rows.Scan(&e.GithubID, &e.TotalStars, &e.TotalRepos); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
```

> 注：`order` 只在固定字符串 `total_stars`/`total_repos` 里二选一，不拼用户输入，无注入风险；`limit` 用占位符。

- [ ] **Step 2: 编译**

```bash
cd playground/services/stats-service
go mod tidy && go build ./...
```
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
cd playground
git add services/stats-service/store.go services/stats-service/go.mod services/stats-service/go.sum
git commit -m "feat(stats-service): repos store with aggregate stats and leaderboard queries"
```

---

## Task 4: GitHub 客户端 + Cloud Map 客户端 + handlers + 接线

**Files:**
- Create: `services/stats-service/github.go`, `profileclient.go`, `handler.go`
- Modify: `services/stats-service/main.go`

**Interfaces:**
- Produces: `FetchRepos(token string) ([]GithubRepo, int, error)`。
- Produces: `ProfileClient{baseURL}`；`(*ProfileClient) ByGithubIDs(ids []int64) (map[int64]ProfileBrief, error)` —— **经 Cloud Map 调 profile-service `/internal/profiles`**。
- Produces: `Handler`；`Collect/Stats/Repos/Leaderboard`。

- [ ] **Step 1: github.go**

```go
package main

import (
	"encoding/json"
	"net/http"
	"time"
)

// FetchRepos 抓当前 token 用户的仓库（分页取前 100）
func FetchRepos(token string) ([]GithubRepo, int, error) {
	req, _ := http.NewRequest("GET", "https://api.github.com/user/repos?per_page=100&sort=updated", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "github-profile-collector")
	client := &http.Client{Timeout: 15 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, res.StatusCode, nil
	}
	var repos []GithubRepo
	if err := json.NewDecoder(res.Body).Decode(&repos); err != nil {
		return nil, res.StatusCode, err
	}
	return repos, 200, nil
}
```

- [ ] **Step 2: profileclient.go（东西向 Cloud Map 调用）**

```go
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type ProfileBrief struct {
	GithubID  int64  `json:"github_id"`
	Login     string `json:"login"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
}

type ProfileClient struct{ baseURL string }

func NewProfileClient(base string) *ProfileClient { return &ProfileClient{baseURL: base} }

// ByGithubIDs 经 Cloud Map 调 profile-service 的 /internal/profiles?github_ids=1,2,3
func (c *ProfileClient) ByGithubIDs(ids []int64) (map[int64]ProfileBrief, error) {
	out := map[int64]ProfileBrief{}
	if len(ids) == 0 {
		return out, nil
	}
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = strconv.FormatInt(id, 10)
	}
	url := fmt.Sprintf("%s/internal/profiles?github_ids=%s", c.baseURL, strings.Join(parts, ","))
	client := &http.Client{Timeout: 5 * time.Second}
	res, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("profile svc status %d", res.StatusCode)
	}
	var list []ProfileBrief
	if err := json.NewDecoder(res.Body).Decode(&list); err != nil {
		return nil, err
	}
	for _, p := range list {
		out[p.GithubID] = p
	}
	return out, nil
}
```

- [ ] **Step 3: handler.go**

```go
package main

import (
	"encoding/json"
	"net/http"
	"strconv"
)

type Handler struct {
	store   *Store
	profile *ProfileClient
}

func NewHandler(s *Store, p *ProfileClient) *Handler { return &Handler{store: s, profile: p} }

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// Collect: BFF 创建时调用；抓该 token 用户的 repos 存库
func (h *Handler) Collect(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token    string `json:"token"`
		GithubID int64  `json:"github_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Token == "" || body.GithubID == 0 {
		writeJSON(w, 400, map[string]string{"error": "token and github_id required"})
		return
	}
	repos, status, err := FetchRepos(body.Token)
	if err != nil || status != 200 {
		writeJSON(w, 502, map[string]string{"error": "github repos error"})
		return
	}
	rows := make([]RepoRow, 0, len(repos))
	for _, gr := range repos {
		rows = append(rows, ToRepoRow(body.GithubID, gr))
	}
	if err := h.store.ReplaceRepos(body.GithubID, rows); err != nil {
		writeJSON(w, 500, map[string]string{"error": "db error"})
		return
	}
	writeJSON(w, 200, map[string]int{"collected": len(rows)})
}

func (h *Handler) Stats(w http.ResponseWriter, r *http.Request) {
	gid, err := strconv.ParseInt(r.PathValue("gid"), 10, 64)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad github_id"})
		return
	}
	list, err := h.store.StatsByUser(gid)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "db error"})
		return
	}
	if list == nil {
		list = []LangStat{}
	}
	writeJSON(w, 200, list)
}

func (h *Handler) Repos(w http.ResponseWriter, r *http.Request) {
	gid, err := strconv.ParseInt(r.PathValue("gid"), 10, 64)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad github_id"})
		return
	}
	list, err := h.store.ReposByUser(gid)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "db error"})
		return
	}
	if list == nil {
		list = []RepoRow{}
	}
	writeJSON(w, 200, list)
}

// Leaderboard: 自己排名 + 经 Cloud Map 调 profile-service 补展示信息
func (h *Handler) Leaderboard(w http.ResponseWriter, r *http.Request) {
	by := r.URL.Query().Get("by")
	entries, err := h.store.Leaderboard(by, 10)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "db error"})
		return
	}
	ids := make([]int64, 0, len(entries))
	for _, e := range entries {
		ids = append(ids, e.GithubID)
	}
	briefs, err := h.profile.ByGithubIDs(ids) // ← 东西向 Cloud Map 调用
	if err == nil {
		for i := range entries {
			if b, ok := briefs[entries[i].GithubID]; ok {
				entries[i].Login = b.Login
				entries[i].Name = b.Name
				entries[i].AvatarURL = b.AvatarURL
			}
		}
	}
	if entries == nil {
		entries = []LeaderboardEntry{}
	}
	writeJSON(w, 200, entries)
}
```

- [ ] **Step 4: 更新 main.go**

`services/stats-service/main.go` 全文替换：
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
	go func() {
		if err := store.EnsureSchemaWithRetry(120, 5*time.Second); err != nil {
			log.Printf("WARN ensure schema failed: %v", err)
			return
		}
		log.Println("schema ready")
	}()

	h := NewHandler(store, NewProfileClient(cfg.ProfileSvcURL))
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("POST /collect", h.Collect)
	mux.HandleFunc("GET /stats/{gid}", h.Stats)
	mux.HandleFunc("GET /repos/{gid}", h.Repos)
	mux.HandleFunc("GET /leaderboard", h.Leaderboard)

	log.Println("stats-service listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}
```

- [ ] **Step 5: 编译 + 测试**

```bash
cd playground/services/stats-service
go build ./... && go test ./...
```
Expected: build 通过；2 test pass。

- [ ] **Step 6: 提交**

```bash
cd playground
git add services/stats-service/github.go services/stats-service/profileclient.go services/stats-service/handler.go services/stats-service/main.go
git commit -m "feat(stats-service): github repos client, cloud map profile client, handlers"
```

---

## Task 5: Dockerfile + 本地 compose 联调（collect/stats/repos）

**Files:**
- Create: `services/stats-service/Dockerfile`, `compose.yaml`, `.dockerignore`

**目标**：本地起 MySQL + stats-service，验证 collect/stats/repos（**leaderboard 的 Cloud Map 补充留到上云测**，本地无 profile-service）。

- [ ] **Step 1: Dockerfile**（同 profile-service）

```dockerfile
FROM golang:1.24-alpine AS build
WORKDIR /src
ENV GOPROXY=https://goproxy.cn,direct
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /stats-service .

FROM gcr.io/distroless/static-debian12
COPY --from=build /stats-service /stats-service
EXPOSE 8080
ENTRYPOINT ["/stats-service"]
```

- [ ] **Step 2: .dockerignore**

```
compose.yaml
*_test.go
```

- [ ] **Step 3: compose.yaml**

```yaml
services:
  db:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: rootpw
      MYSQL_DATABASE: profiles_app
      MYSQL_USER: appuser
      MYSQL_PASSWORD: apppw
    ports: ["3307:3306"]
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
      PROFILE_SVC_URL: http://localhost:9999
    ports: ["8081:8080"]
    depends_on:
      db:
        condition: service_healthy
```
> 本地用 8081/3307 端口避免和 profile-service 的 compose 冲突；`PROFILE_SVC_URL` 指向不存在地址（本地不测 leaderboard 补充）。

- [ ] **Step 4: 联调**

```bash
cd playground/services/stats-service
docker compose up --build -d
sleep 8
curl -s localhost:8081/healthz && echo
curl -s -X POST localhost:8081/collect -H 'Content-Type: application/json' \
  -d '{"token":"你的GitHub_token","github_id":你的github数字id}' && echo   # 期望 {"collected":N}
curl -s localhost:8081/stats/你的github数字id && echo                        # 期望语言统计数组
curl -s localhost:8081/repos/你的github数字id && echo                        # 期望仓库数组
curl -s "localhost:8081/leaderboard?by=stars" && echo                        # 期望有排名(展示字段空,因本地无profile)
docker compose down -v
```
> 你的 github 数字 id：`curl -s -H "Authorization: Bearer 你的token" https://api.github.com/user | grep '"id"'`。

**验证**：collect 返回 collected 数；stats 出语言分布；repos 出列表；leaderboard 有条目（login/name 为空正常）。

- [ ] **Step 5: 提交**

```bash
cd playground
git add services/stats-service/Dockerfile services/stats-service/.dockerignore services/stats-service/compose.yaml
git commit -m "feat(stats-service): dockerfile and local compose integration"
```

---

## Task 6: profile-service 加 /internal/profiles 批量接口（供 Cloud Map 调）

**Files:**
- Modify: `services/profile-service/store.go`, `handler.go`, `main.go`

**Interfaces:**
- Produces: `(*Store) ListByGithubIDs(ids []int64) ([]Profile, error)`；`(*Handler) InternalList(w, r)`；路由 `GET /internal/profiles`。

- [ ] **Step 1: store.go 加方法**（追加到文件末尾）

```go
func (s *Store) ListByGithubIDs(ids []int64) ([]Profile, error) {
	if len(ids) == 0 {
		return []Profile{}, nil
	}
	placeholders := "?"
	args := []any{ids[0]}
	for _, id := range ids[1:] {
		placeholders += ",?"
		args = append(args, id)
	}
	return s.query("SELECT * FROM profiles WHERE github_id IN ("+placeholders+")", args...)
}
```

- [ ] **Step 2: handler.go 加 InternalList**（追加到文件末尾）

```go
func (h *Handler) InternalList(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("github_ids")
	var ids []int64
	for _, p := range strings.Split(raw, ",") {
		if p == "" {
			continue
		}
		if id, err := strconv.ParseInt(p, 10, 64); err == nil {
			ids = append(ids, id)
		}
	}
	list, err := h.store.ListByGithubIDs(ids)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "db error"})
		return
	}
	if list == nil {
		list = []Profile{}
	}
	writeJSON(w, 200, list)
}
```
> `handler.go` 顶部 import 需加 `"strings"`（若尚未导入）。

- [ ] **Step 3: main.go 加路由**

在 profile-service `main.go` 的路由区加一行：
```go
	mux.HandleFunc("GET /internal/profiles", h.InternalList)
```

- [ ] **Step 4: 编译 + 测试**

```bash
cd playground/services/profile-service
go build ./... && go test ./...
```
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
cd playground
git add services/profile-service/store.go services/profile-service/handler.go services/profile-service/main.go
git commit -m "feat(profile-service): internal batch lookup by github_ids for cloud map consumers"
```

---

## Task 7: BFF 编排 + API Gateway 路由扩展

**Files:**
- Modify: `bff/index.mjs`, `infra/bff.tf`

**Interfaces:**
- Produces: `POST /profiles` 编排 profile-service 存档 + stats-service 采集；新增转发 `GET /stats/{gid}`、`GET /repos/{gid}`、`GET /leaderboard`。

- [ ] **Step 1: bff/index.mjs 全文替换**

```javascript
// BFF：POST /profiles 编排两个服务；其余转发到内网 ALB（ALB 按路径分流）
const ALB = process.env.ALB_URL; // http://internal-...elb.amazonaws.com

async function call(method, path, body) {
  const init = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${ALB}${path}`, init);
  const text = await res.text();
  return { status: res.status, text };
}

const CORS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
};

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const path = event.rawPath || "/";
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : "";

  try {
    // 编排：创建 profile 时，先存档、再采集 repos
    if (method === "POST" && path === "/profiles") {
      const body = JSON.parse(event.body || "{}");
      const p = await call("POST", "/profiles", { token: body.token });
      if (p.status !== 201) return { statusCode: p.status, headers: CORS, body: p.text };
      const profile = JSON.parse(p.text);
      // fire stats collection（失败不阻断创建）
      try {
        await call("POST", "/collect", { token: body.token, github_id: profile.github_id });
      } catch (_) {}
      return { statusCode: 201, headers: CORS, body: JSON.stringify(profile) };
    }
    // 其余：原样转发（ALB 按路径路由到 profile / stats）
    const r = await call(method, path + qs, event.body ? JSON.parse(event.body) : undefined);
    return { statusCode: r.status, headers: CORS, body: r.text };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: "bff error" }) };
  }
};
```

- [ ] **Step 2: infra/bff.tf 扩展路由**

把 `aws_apigatewayv2_route.routes` 的 `for_each` 集合改为：
```hcl
  for_each = toset([
    "POST /profiles", "GET /profiles", "GET /profiles/{id}",
    "GET /stats/{gid}", "GET /repos/{gid}", "GET /leaderboard"
  ])
```

- [ ] **Step 3: 校验**

```bash
cd playground/infra
terraform fmt && terraform validate && terraform plan
```
Expected: `plan` 里 API Gateway 路由从 3 条变 6 条（新增 3）；无报错。

- [ ] **Step 4: 提交**

```bash
cd playground
git add bff/index.mjs infra/bff.tf
git commit -m "feat(bff): orchestrate create fan-out and add stats/repos/leaderboard routes"
```

---

## Task 8: Terraform —— stats-service 服务 + ALB 路由调整

**Files:**
- Create: `infra/ecs-stats.tf`
- Modify: `infra/alb.tf`

**Interfaces:**
- Produces: `aws_ecs_service.stats`（挂 stats 目标组）。stats 不需 Cloud Map 注册（它是消费方，只调 profile）。

- [ ] **Step 1: 改 infra/alb.tf 的路由规则**

把 `aws_lb_listener_rule.stats` 的 `path_pattern.values` 改为：
```hcl
      values = ["/leaderboard*", "/repos/*", "/stats/*", "/collect"]
```

- [ ] **Step 2: 写 infra/ecs-stats.tf**

```hcl
resource "aws_cloudwatch_log_group" "stats" {
  name              = "/ecs/${local.name_prefix}-stats-service"
  retention_in_days = 3
}

resource "aws_ecs_task_definition" "stats" {
  family                   = "${local.name_prefix}-stats"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name         = "stats-service"
    image        = "${aws_ecr_repository.stats.repository_url}:latest"
    essential    = true
    portMappings = [{ containerPort = 8080, protocol = "tcp" }]
    environment = [
      { name = "DB_PORT", value = "3306" },
      { name = "PROFILE_SVC_URL", value = "http://profile.svc.internal:8080" }
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
        "awslogs-group"         = aws_cloudwatch_log_group.stats.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "stats"
      }
    }
  }])
}

resource "aws_ecs_service" "stats" {
  name                              = "${local.name_prefix}-stats"
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.stats.arn
  desired_count                     = 1
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 120

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.stats_svc.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.stats.arn
    container_name   = "stats-service"
    container_port   = 8080
  }

  depends_on = [aws_lb_listener.http]
}
```

- [ ] **Step 3: 校验**

```bash
cd playground/infra
terraform fmt && terraform validate && terraform plan
```
Expected: 新增 stats 日志组 + 任务定义 + 服务；alb 规则 in-place 更新（若已 apply）；无报错。

- [ ] **Step 4: 提交**

```bash
cd playground
git add infra/ecs-stats.tf infra/alb.tf
git commit -m "infra: stats-service ecs service and alb path routing to stats target group"
```

---

## Task 9: 上云部署 + Cloud Map 东西向验证 + destroy

**目标**：apply、推**两个**镜像（profile 更新了 + stats 新增）、验证 collect/stats/repos/**leaderboard(经 Cloud Map 拿到展示信息)**，然后 destroy。⚠️ 花钱，验证完必拆。

- [ ] **Step 1: 先建两个 ECR**

```bash
cd playground/infra
terraform workspace select test
terraform apply -target=aws_ecr_repository.profile -target=aws_ecr_repository.stats   # yes
```

- [ ] **Step 2: 构建并推送两个镜像**（字面量地址，`--platform linux/amd64`）

```bash
aws ecr get-login-password --region ap-southeast-1 | docker login --username AWS --password-stdin 930698106220.dkr.ecr.ap-southeast-1.amazonaws.com

# profile-service（本 Plan 加了 /internal/profiles，要重新构建推送）
cd playground/services/profile-service
docker build --platform linux/amd64 -t 930698106220.dkr.ecr.ap-southeast-1.amazonaws.com/profile-test-profile-service:latest .
docker push 930698106220.dkr.ecr.ap-southeast-1.amazonaws.com/profile-test-profile-service:latest

# stats-service（新）
cd ../stats-service
docker build --platform linux/amd64 -t 930698106220.dkr.ecr.ap-southeast-1.amazonaws.com/profile-test-stats-service:latest .
docker push 930698106220.dkr.ecr.ap-southeast-1.amazonaws.com/profile-test-stats-service:latest
```

- [ ] **Step 3: full apply**

```bash
cd playground/infra
terraform apply     # yes；RDS 5-10 分钟；两个 ECS 服务拉镜像
terraform output bff_api_url
```

- [ ] **Step 4: 等两个服务健康**

```bash
aws ecs describe-services --cluster profile-test-cluster \
  --services profile-test-profile profile-test-stats --region ap-southeast-1 \
  --query 'services[].{name:serviceName,running:runningCount,desired:desiredCount}'
```
期望两个都 `running=1`。异常看日志：`aws logs tail /ecs/profile-test-stats-service --region ap-southeast-1 --since 5m`。

- [ ] **Step 5: 端到端 + Cloud Map 东西向验证**

用 `terraform output bff_api_url` 的地址（记为 API）：
```bash
# 创建（BFF 编排：存 profile + 采集 repos）
curl -s -X POST <API>/profiles -H 'Content-Type: application/json' -d '{"token":"你的token"}' && echo

# 拿你的 github_id（上一步返回里的 github_id 字段）
curl -s <API>/stats/你的github_id && echo          # 语言统计
curl -s <API>/repos/你的github_id && echo          # 仓库列表
curl -s "<API>/leaderboard?by=stars" && echo       # ⭐ 榜单：含 login/name/avatar
```
**验证（Cloud Map 东西向落地）**：`leaderboard` 返回的条目里 **login/name/avatar 有值**——这些是 stats-service **经 Cloud Map 调 profile-service** 拿到的（stats 自己没存这些）。若这些字段有值 = 东西向服务发现成功。
> 可选：`aws logs tail /ecs/profile-test-profile-service --since 5m` 能看到 stats 打来的 `/internal/profiles` 请求日志。

- [ ] **Step 6: destroy**

```bash
cd playground/infra
terraform destroy   # yes
```
**验证**：`Destroy complete!`。

- [ ] **Step 7: 推送代码**

```bash
cd playground && git push origin HEAD:main
cd ../.. && git add aws-learning/playground && git commit -m "chore: bump submodule (Plan 3 stats-service)" && git push
```

---

## 自检：spec 覆盖核对（Plan 3 范围）

- stats-service(Go) 拥有 repos 表、抓 /user/repos → Task 2/3/4 ✅
- 语言统计（聚合 SQL）、仓库列表、榜单 → Task 3/4 ✅
- **Cloud Map 东西向**：stats 经 profile.svc.internal 调 profile-service 补榜单展示信息 → Task 4（profileclient）+ Task 6（profile 内部接口）+ Task 9 验证 ✅
- BFF 编排创建 fan-out（profile 存档 + stats 采集）→ Task 7 ✅
- ALB 路径路由 stats 到 stats 目标组 → Task 8 ✅
- 本地 TDD + compose 联调 → Task 2/5 ✅
- IaC 建/拆 → Task 9 ✅
- 前端新页面 / CI/CD → **属 Plan 4/5，本计划不含**（范围正确）

## 交接给 Plan 4/5

- 前端将新增页面消费 `/stats/{gid}`、`/repos/{gid}`、`/leaderboard`。
- Plan 5 CI/CD 会把两个 Go 服务的构建/推送/滚动部署纳入流水线（现为手动 Task 9）。
