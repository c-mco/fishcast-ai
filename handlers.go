package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"sort"
	"sync"
	"time"
)

// ── Singleflight ──────────────────────────────────────────────────────────────
// Ensures that if multiple requests arrive simultaneously for the same cold-cache
// key, only one upstream call is made. All callers wait and share the result.

type inflightCall struct {
	wg  sync.WaitGroup
	val []byte
	err error
}

type Inflight struct {
	mu    sync.Mutex
	calls map[string]*inflightCall
}

func NewInflight() *Inflight {
	return &Inflight{calls: make(map[string]*inflightCall)}
}

func (g *Inflight) Do(key string, fn func() ([]byte, error)) ([]byte, error) {
	g.mu.Lock()
	if c, ok := g.calls[key]; ok {
		g.mu.Unlock()
		c.wg.Wait()
		return c.val, c.err
	}
	c := &inflightCall{}
	c.wg.Add(1)
	g.calls[key] = c
	g.mu.Unlock()

	c.val, c.err = fn()
	c.wg.Done()

	g.mu.Lock()
	delete(g.calls, key)
	g.mu.Unlock()

	return c.val, c.err
}

// ── Shared state ──────────────────────────────────────────────────────────────

const (
	weatherTTL = 10 * time.Minute
	spotsTTL   = 1 * time.Hour
)

var httpClient = &http.Client{Timeout: 20 * time.Second}

// roundCoord rounds a lat/lon value to 2 decimal places (~1.1 km precision)
// to maximise cache hit rate across nearby requests.
func roundCoord(v float64) string {
	return fmt.Sprintf("%.2f", v)
}

// ── /api/weather ──────────────────────────────────────────────────────────────

func weatherHandler(cache *Cache, flight *Inflight) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var lat, lon float64
		if _, err := fmt.Sscanf(r.URL.Query().Get("lat"), "%f", &lat); err != nil {
			http.Error(w, `{"error":"lat required"}`, http.StatusBadRequest)
			return
		}
		if _, err := fmt.Sscanf(r.URL.Query().Get("lon"), "%f", &lon); err != nil {
			http.Error(w, `{"error":"lon required"}`, http.StatusBadRequest)
			return
		}

		key := fmt.Sprintf("weather:%s:%s", roundCoord(lat), roundCoord(lon))

		if data, ok := cache.Get(key); ok {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("X-Cache", "HIT")
			w.Write(data)
			return
		}

		data, err := flight.Do(key, func() ([]byte, error) {
			url := fmt.Sprintf(
				"https://api.open-meteo.com/v1/forecast?latitude=%.6f&longitude=%.6f"+
					"&current=temperature_2m,wind_speed_10m,cloud_cover,precipitation_probability,weather_code"+
					"&timezone=auto",
				lat, lon,
			)
			resp, err := httpClient.Get(url)
			if err != nil {
				return nil, err
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				return nil, fmt.Errorf("open-meteo returned %d", resp.StatusCode)
			}
			return io.ReadAll(resp.Body)
		})
		if err != nil {
			log.Printf("weather upstream error: %v", err)
			http.Error(w, `{"error":"upstream error"}`, http.StatusBadGateway)
			return
		}

		cache.Set(key, data, weatherTTL)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Cache", "MISS")
		w.Write(data)
	}
}

// ── /api/spots — iNaturalist fish observations ────────────────────────────────
//
// Fetches real fish observations from iNaturalist within radiusKm of the
// given coordinates, then clusters them into hotspots (~500m grid cells).

type Hotspot struct {
	Name        string   `json:"name"`
	Lat         float64  `json:"lat"`
	Lon         float64  `json:"lon"`
	Species     []string `json:"species"`
	Count       int      `json:"count"`
	LastSeen    string   `json:"last_seen"`
	QualityRank int      `json:"quality_rank"` // higher = more/recent observations
}

func spotsHandler(cache *Cache, flight *Inflight) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var lat, lon float64
		if _, err := fmt.Sscanf(r.URL.Query().Get("lat"), "%f", &lat); err != nil {
			http.Error(w, `{"error":"lat required"}`, http.StatusBadRequest)
			return
		}
		if _, err := fmt.Sscanf(r.URL.Query().Get("lon"), "%f", &lon); err != nil {
			http.Error(w, `{"error":"lon required"}`, http.StatusBadRequest)
			return
		}
		radius := r.URL.Query().Get("radius")
		if radius == "" {
			radius = "25"
		}

		key := fmt.Sprintf("spots:%s:%s:%s", roundCoord(lat), roundCoord(lon), radius)

		if data, ok := cache.Get(key); ok {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("X-Cache", "HIT")
			w.Write(data)
			return
		}

		data, err := flight.Do(key, func() ([]byte, error) {
			apiURL := fmt.Sprintf(
				"https://api.inaturalist.org/v1/observations"+
					"?iconic_taxa=Actinopterygii"+
					"&lat=%.6f&lng=%.6f&radius=%s"+
					"&per_page=200&order_by=observed_on"+
					"&quality_grade=research",
				lat, lon, radius,
			)
			resp, err := httpClient.Get(apiURL)
			if err != nil {
				return nil, err
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				return nil, fmt.Errorf("iNaturalist returned %d", resp.StatusCode)
			}
			body, err := io.ReadAll(resp.Body)
			if err != nil {
				return nil, err
			}

			hotspots, err := clusterObservations(body)
			if err != nil {
				return nil, err
			}
			return json.Marshal(map[string]any{
				"source":   "iNaturalist",
				"hotspots": hotspots,
			})
		})
		if err != nil {
			log.Printf("spots upstream error: %v", err)
			http.Error(w, `{"error":"upstream error"}`, http.StatusBadGateway)
			return
		}

		cache.Set(key, data, spotsTTL)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Cache", "MISS")
		w.Write(data)
	}
}

// clusterObservations groups iNaturalist fish observations into ~500m hotspots.
func clusterObservations(body []byte) ([]Hotspot, error) {
	var raw struct {
		Results []struct {
			Location   string `json:"location"`
			ObservedOn string `json:"observed_on"`
			PlaceGuess string `json:"place_guess"`
			Taxon      *struct {
				Name              string `json:"name"`
				PreferredCommonName string `json:"preferred_common_name"`
			} `json:"taxon"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}

	type cell struct {
		lat, lon    float64
		species     map[string]struct{}
		count       int
		lastSeen    string
		placeGuess  string
	}
	grid := map[string]*cell{}

	for _, obs := range raw.Results {
		var olat, olon float64
		if _, err := fmt.Sscanf(obs.Location, "%f,%f", &olat, &olon); err != nil {
			continue
		}
		// ~500m grid (0.005° ≈ 550m)
		gridLat := math.Round(olat/0.005) * 0.005
		gridLon := math.Round(olon/0.005) * 0.005
		key := fmt.Sprintf("%.3f,%.3f", gridLat, gridLon)

		if grid[key] == nil {
			grid[key] = &cell{lat: gridLat, lon: gridLon, species: map[string]struct{}{}}
		}
		c := grid[key]
		c.count++
		if obs.Taxon != nil {
			name := obs.Taxon.PreferredCommonName
			if name == "" {
				name = obs.Taxon.Name
			}
			c.species[name] = struct{}{}
		}
		if obs.ObservedOn > c.lastSeen {
			c.lastSeen = obs.ObservedOn
		}
		if c.placeGuess == "" && obs.PlaceGuess != "" {
			c.placeGuess = obs.PlaceGuess
		}
	}

	hotspots := make([]Hotspot, 0, len(grid))
	for _, c := range grid {
		species := make([]string, 0, len(c.species))
		for s := range c.species {
			species = append(species, s)
		}
		sort.Strings(species)

		name := c.placeGuess
		if name == "" {
			name = fmt.Sprintf("%.3f, %.3f", c.lat, c.lon)
		}

		hotspots = append(hotspots, Hotspot{
			Name:        name,
			Lat:         c.lat,
			Lon:         c.lon,
			Species:     species,
			Count:       c.count,
			LastSeen:    c.lastSeen,
			QualityRank: c.count,
		})
	}

	// Sort by most observations descending
	sort.Slice(hotspots, func(i, j int) bool {
		return hotspots[i].QualityRank > hotspots[j].QualityRank
	})
	if len(hotspots) > 20 {
		hotspots = hotspots[:20]
	}
	return hotspots, nil
}

// ── /health ───────────────────────────────────────────────────────────────────

func healthHandler(cache *Cache) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hits, misses, size := cache.Stats()
		total := hits + misses
		hitRate := 0.0
		if total > 0 {
			hitRate = float64(hits) / float64(total) * 100
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"status":    "ok",
			"cache":     map[string]any{"hits": hits, "misses": misses, "entries": size, "hit_rate_pct": fmt.Sprintf("%.1f", hitRate)},
			"ttls":      map[string]string{"weather": weatherTTL.String(), "spots": spotsTTL.String()},
		})
	}
}
