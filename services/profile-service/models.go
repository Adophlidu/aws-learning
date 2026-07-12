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
