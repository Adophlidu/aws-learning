package main

import "os"

type Config struct {
	DBHost, DBPort, DBUser, DBPassword, DBName string
	ProfileSvcURL                              string // 经 Cloud Map: http://profile.svc.internal:8080
}

func LoadConfig() Config {
	return Config{
		DBHost:        os.Getenv("DB_HOST"),
		DBPort:        getenv("DB_PORT", "3306"),
		DBUser:        os.Getenv("DB_USER"),
		DBPassword:    os.Getenv("DB_PASSWORD"),
		DBName:        os.Getenv("DB_NAME"),
		ProfileSvcURL: getenv("PROFILE_SVC_URL", "http://profile.svc.internal:8080"),
	}
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
