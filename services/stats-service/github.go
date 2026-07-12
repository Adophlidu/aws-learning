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
