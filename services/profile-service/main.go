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

	// 后台等 RDS 就绪并建表，不阻塞 HTTP 启动 → /healthz 立即可用、ALB 快速 healthy
	go func() {
		if err := store.EnsureSchemaWithRetry(120, 5*time.Second); err != nil {
			log.Printf("WARN ensure schema failed: %v", err)
			return
		}
		log.Println("schema ready")
	}()

	h := NewHandler(store)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("POST /profiles", h.CreateProfile)
	mux.HandleFunc("GET /profiles", h.ListProfiles)
	mux.HandleFunc("GET /profiles/{id}", h.GetProfile)

	log.Println("profile-service listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}
