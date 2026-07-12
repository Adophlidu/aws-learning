package main

import (
	"database/sql"
	"fmt"
	"log"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

type Store struct{ db *sql.DB }

func NewStore(cfg Config) (*Store, error) {
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?parseTime=true&timeout=5s",
		cfg.DBUser, cfg.DBPassword, cfg.DBHost, cfg.DBPort, cfg.DBName)
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	db.SetConnMaxLifetime(5 * time.Minute)
	db.SetMaxOpenConns(10)
	return &Store{db: db}, nil
}

func (s *Store) Close() { _ = s.db.Close() }

const schema = `CREATE TABLE IF NOT EXISTS repos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  github_id BIGINT NOT NULL,
  repo_name VARCHAR(255) NOT NULL,
  language VARCHAR(100),
  stargazers_count INT DEFAULT 0,
  updated_at DATETIME NULL,
  UNIQUE KEY uq_owner_repo (github_id, repo_name),
  INDEX idx_github_id (github_id)
)`

func (s *Store) EnsureSchemaWithRetry(attempts int, wait time.Duration) error {
	var err error
	for i := 0; i < attempts; i++ {
		if err = s.db.Ping(); err == nil {
			if _, err = s.db.Exec(schema); err == nil {
				return nil
			}
		}
		log.Printf("db not ready (%d/%d): %v", i+1, attempts, err)
		time.Sleep(wait)
	}
	return err
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ReplaceRepos 先删该用户旧 repos 再批量插新（一个用户的仓库是一次性刷新的）
func (s *Store) ReplaceRepos(githubID int64, rows []RepoRow) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("DELETE FROM repos WHERE github_id=?", githubID); err != nil {
		return err
	}
	for _, r := range rows {
		if _, err = tx.Exec(
			"INSERT INTO repos (github_id, repo_name, language, stargazers_count, updated_at) VALUES (?,?,?,?,?)",
			r.GithubID, r.RepoName, nullStr(r.Language), r.Stargazers, nullStr(r.UpdatedAt)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) StatsByUser(githubID int64) ([]LangStat, error) {
	rows, err := s.db.Query(`SELECT COALESCE(language,'Unknown') lang, COUNT(*) c, COALESCE(SUM(stargazers_count),0) s
	  FROM repos WHERE github_id=? GROUP BY lang ORDER BY s DESC`, githubID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LangStat
	for rows.Next() {
		var l LangStat
		if err := rows.Scan(&l.Language, &l.RepoCount, &l.StarSum); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func (s *Store) ReposByUser(githubID int64) ([]RepoRow, error) {
	rows, err := s.db.Query(`SELECT github_id, repo_name, COALESCE(language,''), stargazers_count, COALESCE(updated_at,'')
	  FROM repos WHERE github_id=? ORDER BY stargazers_count DESC LIMIT 100`, githubID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RepoRow
	for rows.Next() {
		var r RepoRow
		if err := rows.Scan(&r.GithubID, &r.RepoName, &r.Language, &r.Stargazers, &r.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Leaderboard 按 stars 或 repos 排名；只填 github_id/stars/repos，展示字段由 handler 经 Cloud Map 补
func (s *Store) Leaderboard(by string, limit int) ([]LeaderboardEntry, error) {
	order := "total_stars"
	if by == "repos" {
		order = "total_repos"
	}
	q := fmt.Sprintf(`SELECT github_id, COALESCE(SUM(stargazers_count),0) total_stars, COUNT(*) total_repos
	  FROM repos GROUP BY github_id ORDER BY %s DESC LIMIT ?`, order)
	rows, err := s.db.Query(q, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LeaderboardEntry
	for rows.Next() {
		var e LeaderboardEntry
		if err := rows.Scan(&e.GithubID, &e.TotalStars, &e.TotalRepos); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
