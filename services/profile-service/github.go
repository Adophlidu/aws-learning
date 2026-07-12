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
