package main

import "testing"

func TestToRow(t *testing.T) {
	u := GithubUser{
		ID: 583231, Login: "octocat", Name: "The Octocat",
		AvatarURL: "https://a/u/583231", Bio: "hi", Company: "@github",
		Location: "SF", PublicRepos: 8, Followers: 100, Following: 9,
		CreatedAt: "2011-01-25T18:44:36Z",
	}
	got := ToRow(u)
	if got.GithubID != 583231 || got.Login != "octocat" {
		t.Fatalf("core fields wrong: %+v", got)
	}
	if got.GithubCreatedAt != "2011-01-25 18:44:36" {
		t.Fatalf("created_at not normalized: %q", got.GithubCreatedAt)
	}
}

func TestToRowEmptyCreatedAt(t *testing.T) {
	got := ToRow(GithubUser{ID: 1, Login: "a"})
	if got.GithubCreatedAt != "" {
		t.Fatalf("want empty, got %q", got.GithubCreatedAt)
	}
}
