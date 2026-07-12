package main

import "strings"

func ToRow(u GithubUser) Profile {
	created := ""
	if u.CreatedAt != "" {
		created = strings.Replace(strings.Replace(u.CreatedAt, "T", " ", 1), "Z", "", 1)
	}
	return Profile{
		GithubID: u.ID, Login: u.Login, Name: u.Name, AvatarURL: u.AvatarURL,
		Bio: u.Bio, Company: u.Company, Location: u.Location,
		PublicRepos: u.PublicRepos, Followers: u.Followers, Following: u.Following,
		GithubCreatedAt: created,
	}
}
