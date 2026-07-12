# Phase 4：前端新页面实施计划

> 对应设计文档 `docs/2026-07-12-architecture-overhaul-design.md` §2/§3 的「仓库+语言统计 / 排行榜 / 搜索」三块前端。
> **本 Plan 全程为纯前端本地代码 + 本地构建验证，无任何 AWS 操作**（部署归 Plan 5 CI/CD）。

**Goal:** 给已经跑通的 Go 微服务后端补上消费其新接口的前端页面，让 stats-service 的「语言统计 / 仓库 / 榜单」和 profile-service 的「搜索」在 UI 上真正被用到。

**Architecture:** TanStack Router（文件式路由）+ Vite + React 19 + Tailwind v4（Neon Protocol 主题，`np-` token）。所有请求经 `VITE_API_URL` → API Gateway → BFF → 内网 ALB → Go 服务。沿用现有 `apps/web/src/lib/api.ts` 单文件 API 客户端 + 现有页面视觉语言。

**Tech Stack:** React 19、@tanstack/react-router、lucide-react、sonner、Tailwind v4、Ultracite/Biome。

## Global Constraints

- 语言：注释/文案用简体中文（技术名词可英文），UI 沿用现有赛博朋克英文标签风格。
- 代码规范：遵守 Ultracite/Biome（`pnpm dlx ultracite fix apps/web/src`）；`for...of`、`??`/`||`、箭头函数、`<img>` 需 `alt`、组件不内嵌定义。
- 路由文件（`routes/**`）豁免 `useFilenamingConvention`，用 `xxx.tsx` / `xxx.$id.tsx`。
- **只改 `frontend/apps/web/src` 下文件**；不碰 backend/services/infra。
- 验证只用本地命令 `pnpm -F web build`、`pnpm dlx ultracite check apps/web/src`——不是 AWS 操作。

---

## API 契约（后端已实现，实测通过）

| 方法 & 路径 | 响应类型 | 字段 |
|---|---|---|
| `GET /profiles?q=&location=&minFollowers=` | `Profile[]` | id, github_id, login, name, avatar_url, bio, company, location, public_repos, followers, following, github_created_at |
| `GET /profiles/{id}` | `Profile` | 同上（**注意：Go 服务已移除 `stored_at`；空值返回 `""` 而非 `null`**） |
| `GET /stats/{gid}` | `LangStat[]` | language, repo_count, star_sum（按 star_sum 降序） |
| `GET /repos/{gid}` | `RepoStat[]` | github_id, repo_name, language, stargazers_count, updated_at（按 star 降序，≤100） |
| `GET /leaderboard?by=stars\|repos` | `LeaderboardEntry[]` | github_id, login, name, avatar_url, total_stars, total_repos（top 10） |

> **两处与旧前端/设计文档的偏差，本 Plan 负责对齐：**
> 1. 旧 `ProfileDetail.stored_at` 已不存在 → 详情页移除「Archived At」。
> 2. 榜单 `by` 后端只实现 `stars`/`repos`（设计文档提的 `followers` 无对应字段）→ 前端切换只做这两项。
> 3. Go 空字符串不是 `null`，`bio ?? "—"` 对 `""` 不生效 → 统一用 `text || "—"` 兜底。

---

## Task 1：扩展 `api.ts`（类型 + 客户端函数）

**Files:** Modify `frontend/apps/web/src/lib/api.ts`

**要点：**
- `Profile` 统一为 Go 服务实际返回的形状（含 `github_id`，去掉 `stored_at`）。`listProfiles`/`getProfile`/`searchProfiles` 共用它。
- 新增类型 `LangStat`、`RepoStat`、`LeaderboardEntry`、`LeaderboardBy`、`SearchFilter`。
- 新增函数 `searchProfiles(filter)`、`getStats(gid)`、`getRepos(gid)`、`getLeaderboard(by)`。
- 保留现有 `submitToken`、`parseError`。

**Interfaces produced（后续任务依赖）：**
```ts
export type LeaderboardBy = "stars" | "repos";
export interface Profile { id:number; github_id:number; login:string; name:string;
  avatar_url:string; bio:string; company:string; location:string;
  public_repos:number; followers:number; following:number; github_created_at:string; }
export interface LangStat { language:string; repo_count:number; star_sum:number; }
export interface RepoStat { github_id:number; repo_name:string; language:string;
  stargazers_count:number; updated_at:string; }
export interface LeaderboardEntry { github_id:number; login:string; name:string;
  avatar_url:string; total_stars:number; total_repos:number; }
export interface SearchFilter { q?:string; location?:string; minFollowers?:number; }
// functions:
listProfiles(): Promise<Profile[]>
getProfile(id): Promise<Profile>
searchProfiles(f: SearchFilter): Promise<Profile[]>
getStats(gid: number): Promise<LangStat[]>
getRepos(gid: number): Promise<RepoStat[]>
getLeaderboard(by: LeaderboardBy): Promise<LeaderboardEntry[]>
submitToken(token): Promise<Profile>
```

- [ ] Step 1：改写 `api.ts` 全文（见下）
- [ ] Step 2：`pnpm dlx ultracite check apps/web/src/lib/api.ts` 通过

完整代码见实现（一个 `request<T>` 助手统一 fetch+错误处理，`searchProfiles` 用 `URLSearchParams` 拼查询串）。

---

## Task 2：详情页加「语言统计 + 仓库列表」

**Files:** Modify `frontend/apps/web/src/routes/profiles.$id.tsx`

**Consumes:** `getProfile`、`getStats`、`getRepos`、`LangStat`、`RepoStat`。

**要点：**
- 拿到 `profile` 后用 `profile.github_id` 并行拉 `getStats(gid)` + `getRepos(gid)`。
- **语言统计**：横向占比条，`star_sum` 归一化算宽度；每行显示 language / repo_count / star_sum。
- **仓库列表**：top 仓库表格（repo_name、language、⭐stargazers_count、updated_at）。
- 移除「Archived At」MetaPacket（`stored_at` 已不存在）。
- 所有 `xxx ?? "—"` 改 `xxx || "—"`（兼容 Go 空串）。
- stats/repos 加载失败不阻断 profile 展示（各自 try/catch + 局部空态）。

- [ ] Step 1：加 stats/repos 的 state + 并行加载
- [ ] Step 2：加 LanguageStats、RepoTable 两个子组件（组件定义在文件顶层，不内嵌）
- [ ] Step 3：移除 Archived At、空串兜底
- [ ] Step 4：`pnpm -F web build` 通过

---

## Task 3：新增排行榜路由 `/leaderboard`

**Files:** Create `frontend/apps/web/src/routes/leaderboard.tsx`

**Consumes:** `getLeaderboard`、`LeaderboardEntry`、`LeaderboardBy`。

**要点：**
- Stars / Repos 两个 tab（`by` state），切换重新拉取。
- top 10 榜：名次、头像、@login + name、total_stars、total_repos；当前排序维度高亮。
- 每行 `Link to="/profiles/$id"`——但榜单只有 `github_id` 没有 DB `id`。**处理：** 榜单条目点击跳到搜索页并以 login 预填（`/search?q=login`），避免 id 不匹配。（详情页走 DB id，榜单走 github_id，两者不可直接互转。）
- 空态 / 加载态 / 错误 toast。

- [ ] Step 1：写 `leaderboard.tsx`
- [ ] Step 2：`pnpm -F web build` 路由生成成功

---

## Task 4：新增搜索路由 `/search`

**Files:** Create `frontend/apps/web/src/routes/search.tsx`

**Consumes:** `searchProfiles`、`Profile`、`SearchFilter`。

**要点：**
- 表单：关键词 `q`（login/name 模糊）、`location`、`minFollowers`。
- 支持 URL query 预填（`validateSearch`）——供榜单跳转 `/search?q=login`。
- 提交 → `searchProfiles` → 复用首页 profile 卡片网格（卡片链接到 `/profiles/$id`，用返回的 `id`）。
- 空态「无匹配」、加载态。

- [ ] Step 1：写 `search.tsx`（含 `validateSearch`）
- [ ] Step 2：`pnpm -F web build` 通过

---

## Task 5：导航头链接 + 全量验证 + 提交

**Files:** Modify `frontend/apps/web/src/components/neon-header.tsx`

**要点：**
- 把占位 `NAV_ITEMS` 换成真实 `Link`：TERMINAL→`/`、LEADERBOARD→`/leaderboard`、SEARCH→`/search`。用 `useLocation` 高亮当前路由。
- 保留 `showReturn` 逻辑与视觉。

- [ ] Step 1：改 `neon-header.tsx` 为真实导航
- [ ] Step 2：`pnpm dlx ultracite fix apps/web/src` 自动修复
- [ ] Step 3：`pnpm dlx ultracite check apps/web/src` 零告警
- [ ] Step 4：`pnpm -F web build` 成功产出 `apps/web/dist`
- [ ] Step 5：提交（submodule 仓库 `Adophlidu/aws-learning`）

---

## 验证策略（全本地，无 AWS）

1. `pnpm -F web build` —— TanStack 路由生成 + Vite 打包全过。
2. `pnpm dlx ultracite check apps/web/src` —— 规范零告警。
3. 类型：`Profile`/`LangStat`/`RepoStat`/`LeaderboardEntry` 在各页引用一致。

> **不在本 Plan 部署**：真机联调（前端指向真实 API Gateway）留到 Plan 5——届时前端随 CI/CD 部署到 S3+CloudFront、`VITE_API_URL` 注入新 API。本 Plan 交付「构建通过、契约对齐」的前端代码。

## 风险

- 榜单 `github_id` 与详情页 DB `id` 不可互转 → 榜单点击走 `/search?q=login` 迂回（已在 Task 3 处理）。
- Go 返回空串非 null → 全量用 `|| "—"` 兜底（Task 1/2）。
- `pnpm allowBuilds` esbuild 坑：`pnpm-workspace.yaml` 需 `esbuild: true`（既有配置，构建前确认）。
