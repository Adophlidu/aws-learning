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
