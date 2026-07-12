package main

import (
	"log"
	"net/http"
	"time"
)

func main() {
	cfg := LoadConfig()
	store, err := NewStore(cfg)
	if err != nil {
		log.Fatalf("store init: %v", err)
	}
	defer store.Close()
	go func() {
		if err := store.EnsureSchemaWithRetry(120, 5*time.Second); err != nil {
			log.Printf("WARN ensure schema failed: %v", err)
			return
		}
		log.Println("schema ready")
	}()

	h := NewHandler(store, NewProfileClient(cfg.ProfileSvcURL))
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("POST /collect", h.Collect)
	mux.HandleFunc("GET /stats/{gid}", h.Stats)
	mux.HandleFunc("GET /repos/{gid}", h.Repos)
	mux.HandleFunc("GET /leaderboard", h.Leaderboard)

	log.Println("stats-service listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}
