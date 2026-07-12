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
