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
