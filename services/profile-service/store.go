package main

import (
	"database/sql"
	"fmt"
	"log"
	"strings"
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

const schema = `CREATE TABLE IF NOT EXISTS profiles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  github_id BIGINT UNIQUE NOT NULL,
  login VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  avatar_url VARCHAR(512),
  bio TEXT,
  company VARCHAR(255),
  location VARCHAR(255),
  public_repos INT,
  followers INT,
  following INT,
  github_created_at DATETIME NULL,
  stored_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`

// EnsureSchemaWithRetry 等 RDS 就绪并建表（apply 时 RDS 可能还在创建）
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

func (s *Store) Upsert(p Profile) (Profile, error) {
	_, err := s.db.Exec(`INSERT INTO profiles
      (github_id, login, name, avatar_url, bio, company, location,
       public_repos, followers, following, github_created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       login=VALUES(login), name=VALUES(name), avatar_url=VALUES(avatar_url),
       bio=VALUES(bio), company=VALUES(company), location=VALUES(location),
       public_repos=VALUES(public_repos), followers=VALUES(followers),
       following=VALUES(following), github_created_at=VALUES(github_created_at)`,
		p.GithubID, p.Login, nullStr(p.Name), nullStr(p.AvatarURL), nullStr(p.Bio),
		nullStr(p.Company), nullStr(p.Location), p.PublicRepos, p.Followers,
		p.Following, nullStr(p.GithubCreatedAt))
	if err != nil {
		return Profile{}, err
	}
	rows, err := s.query("SELECT * FROM profiles WHERE github_id=?", p.GithubID)
	if err != nil {
		return Profile{}, err
	}
	if len(rows) == 0 {
		return Profile{}, fmt.Errorf("upsert: row not found after insert")
	}
	return rows[0], nil
}

func (s *Store) List(f SearchFilter) ([]Profile, error) {
	q := "SELECT * FROM profiles WHERE 1=1"
	var args []any
	if f.Q != "" {
		q += " AND (login LIKE ? OR name LIKE ?)"
		like := "%" + f.Q + "%"
		args = append(args, like, like)
	}
	if f.Location != "" {
		q += " AND location LIKE ?"
		args = append(args, "%"+f.Location+"%")
	}
	if f.MinFollowers > 0 {
		q += " AND followers >= ?"
		args = append(args, f.MinFollowers)
	}
	q += " ORDER BY id DESC LIMIT 100"
	return s.query(q, args...)
}

func (s *Store) GetByID(id int64) (*Profile, error) {
	rows, err := s.query("SELECT * FROM profiles WHERE id=?", id)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return &rows[0], nil
}

// query 把结果扫描进 []Profile
func (s *Store) query(q string, args ...any) ([]Profile, error) {
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Profile
	for rows.Next() {
		var p Profile
		var name, avatar, bio, company, location, created, storedAt sql.NullString
		if err := rows.Scan(&p.ID, &p.GithubID, &p.Login, &name, &avatar, &bio,
			&company, &location, &p.PublicRepos, &p.Followers, &p.Following,
			&created, &storedAt); err != nil {
			return nil, err
		}
		p.Name, p.AvatarURL, p.Bio = name.String, avatar.String, bio.String
		p.Company, p.Location, p.GithubCreatedAt = company.String, location.String, strings.TrimSpace(created.String)
		out = append(out, p)
	}
	return out, rows.Err()
}

// ListByGithubIDs 按 github_id 批量查（供 stats-service 经 Cloud Map 调用）
func (s *Store) ListByGithubIDs(ids []int64) ([]Profile, error) {
	if len(ids) == 0 {
		return []Profile{}, nil
	}
	placeholders := "?"
	args := []any{ids[0]}
	for _, id := range ids[1:] {
		placeholders += ",?"
		args = append(args, id)
	}
	return s.query("SELECT * FROM profiles WHERE github_id IN ("+placeholders+")", args...)
}
