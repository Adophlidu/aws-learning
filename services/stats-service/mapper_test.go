package main

import "testing"

func TestToRepoRow(t *testing.T) {
	r := GithubRepo{Name: "hello", Language: "Go", Stargazers: 42, UpdatedAt: "2024-01-02T03:04:05Z"}
	got := ToRepoRow(583231, r)
	if got.GithubID != 583231 || got.RepoName != "hello" || got.Language != "Go" || got.Stargazers != 42 {
		t.Fatalf("wrong: %+v", got)
	}
	if got.UpdatedAt != "2024-01-02 03:04:05" {
		t.Fatalf("updated_at not normalized: %q", got.UpdatedAt)
	}
}

func TestToRepoRowNoLanguage(t *testing.T) {
	got := ToRepoRow(1, GithubRepo{Name: "x"})
	if got.Language != "" {
		t.Fatalf("want empty language, got %q", got.Language)
	}
}
