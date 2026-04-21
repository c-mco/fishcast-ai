package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	cache := NewCache()
	flight := NewInflight()

	mux := http.NewServeMux()

	// Static frontend
	mux.Handle("/", http.FileServer(http.Dir("static")))

	// Clean URL for accessibility statement
	mux.HandleFunc("/accessibility", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "static/accessibility.html")
	})

	// API routes
	mux.HandleFunc("/api/weather", weatherHandler(cache, flight))
	mux.HandleFunc("/api/spots", spotsHandler(cache, flight))
	mux.HandleFunc("/health", healthHandler(cache))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	srv := &http.Server{
		Addr:         "0.0.0.0:" + port,
		Handler:      chain(mux, loggingMiddleware, gzipMiddleware),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		log.Printf("🎣 FishCast running → http://localhost:%s", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	// Graceful shutdown on SIGINT / SIGTERM
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down gracefully…")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
	log.Println("Done.")
}
