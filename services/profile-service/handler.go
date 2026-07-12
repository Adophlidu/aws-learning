package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
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

// InternalList: 按 github_ids 批量查（供 stats-service 经 Cloud Map 调用）
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
