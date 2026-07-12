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
