// Package api is tgdl-core's HTTP surface on 127.0.0.1.
//
//	GET  /health             liveness + version + features (no token)
//	POST /v1/hash            {"path": "/abs/file"} -> {"sha256","size","mtimeMs"};
//	POST /v1/hash-batch      {"paths": ["/abs/file", ...]} -> per-file results
//	                         only files inside the allowed roots (403 EOUTSIDE otherwise)
//	POST /v1/tar-gz         {"root": "/abs/staging"} -> streamed tar.gz snapshot
//	POST /v1/fs/remove-tree {"root": "/abs/dir", "keep": ["/abs/file"]}
//	                         -> remove files below root except keep paths
//	POST /v1/fs/stat-batch   {"paths": [...]} -> fs.stat per path, Node's error codes
//	POST /v1/fs/walk         recursive fs.readdir (+ fs.stat), NDJSON stream
//	POST /v1/dbscan          face-embedding DBSCAN, NDJSON progress + result
//	POST /v1/zip             STORE-mode ZIP stream from allow-root files
//	POST /v1/faststart       move an MP4 moov atom with bounded ffmpeg workers
//	POST /v1/thumb/{video,image,audio}
//	                          decode, scale and encode a WebP thumbnail
//	POST /v1/seekbar         decode, sample, tile and encode a video sprite
//	POST /v1/db/group-aggregates
//	                         read-only SQLite group counts/names
//	POST /v1/db/stats       read-only SQLite total file/byte counts
//	POST /v1/db/group-stats read-only per-group counts and timestamps
//	POST /v1/db/group-files read-only paginated per-group file rows
//	POST /v1/db/group-download-ids
//	                         read-only keyset-paged ids for group cleanup
//	POST /v1/db/nsfw-candidates
//	                         read-only bounded unscanned NSFW queue
//	POST /v1/db/downloads/all
//	                         read-only local gallery feed
//	POST /v1/db/downloads/group
//	                         read-only local per-group gallery feed
//	POST /v1/db/downloads/by-ids
//	                         read-only bounded rows for bulk file operations
//	POST /v1/db/downloads/search
//	                         read-only local FTS/LIKE search
//	POST /v1/db/thumbs-list
//	                         read-only thumbnail maintenance catalog
//	POST /v1/db/seekbar-list
//	                         read-only seekbar sprite catalog
//	POST /v1/db/faces-by-download
//	                         read-only face boxes for one download
//	POST /v1/db/person-groups
//	                         read-only compact people grouping
//	POST /v1/db/person-photos
//	                         read-only people gallery page
//	POST /v1/db/face-embeddings
//	                         read-only keyset-paged face embeddings
//	POST /v1/db/ai-counts
//	                         read-only AI maintenance counters
//	POST /v1/db/ai-candidates
//	                         read-only bounded AI indexing queue
//	POST /v1/db/ai-pending
//	                         read-only pending AI scan count
//	POST /v1/db/quality-candidates
//	                         read-only bounded AI quality queue with face boxes
//	POST /v1/db/recovery-stats
//	                         read-only grouped recovery counters
//	POST /v1/db/cluster-downloads-since
//	                         read-only local catalog delta
//	POST /v1/db/cluster-downloads
//	                         read-only local catalog page
//	POST /v1/db/cluster-search
//	                         read-only local catalog search
//	POST /v1/db/telegram-media-candidates
//	                         read-only Telegram media identity candidates
//	POST /v1/db/file-hash-candidates
//	                         read-only content-dedup candidates
//	POST /v1/db/file-name-candidates
//	                         read-only filename/size dedup candidates
//	POST /v1/db/dedup-stats
//	                         read-only dedup coverage counters
//	POST /v1/db/seekbar-stats
//	                         read-only seekbar cache counters
//	POST /v1/db/seekbar-candidates
//	                         read-only keyset-paged video backlog
//	POST /v1/db/faststart-candidates
//	                         read-only keyset-paged video catalog
//	POST /v1/db/faststart-stats
//	                         read-only video catalog count
//	POST /v1/db/disk-rotator-candidates
//	                         read-only oldest unpinned catalog rows
//	POST /v1/db/integrity-candidates
//	                         read-only keyset-paged local file catalog
//	POST /v1/db/integrity-check
//	                         read-only SQLite integrity check
//	POST /v1/db/dedup-candidates
//	                         read-only keyset-paged unhashed file catalog
//	POST /v1/db/dedup-groups
//	                         read-only keyset-paged hash groups
//	POST /v1/db/dedup-files
//	                         read-only batched duplicate file details
//	GET  /v1/stats           counters (cheap token check for the parent)
//
// Every route except /health requires the X-API-Token header, unknown
// routes included, so an unauthenticated caller learns nothing beyond
// what /health says.
package api

import (
	"crypto/subtle"
	"log/slog"
	"net/http"
	"os"
	"runtime"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/dbread"
	"github.com/botnick/telegram-media-downloader/core-service/internal/dbscan"
	"github.com/botnick/telegram-media-downloader/core-service/internal/faststart"
	"github.com/botnick/telegram-media-downloader/core-service/internal/fsx"
	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
	"github.com/botnick/telegram-media-downloader/core-service/internal/seekbar"
	"github.com/botnick/telegram-media-downloader/core-service/internal/tarstream"
	"github.com/botnick/telegram-media-downloader/core-service/internal/thumbs"
	"github.com/botnick/telegram-media-downloader/core-service/internal/version"
	"github.com/botnick/telegram-media-downloader/core-service/internal/zipstream"
)

// TokenHeader carries the shared secret (same header as the other sidecars).
const TokenHeader = "X-API-Token"

// maxQueuedHashes bounds requests waiting for a hash slot.
const maxQueuedHashes = 1024

// Server wires the routes.
type Server struct {
	token     []byte
	log       *slog.Logger
	roots     *hash.Roots
	limiter   *hash.Limiter
	stats     *hash.Stats
	fsStats   *fsx.Stats
	dbRead    *dbread.Handler
	startedAt time.Time
}

// New builds a Server. hashConcurrency follows HASH_WORKER_POOL_SIZE;
// roots limits which files may be read (nil or empty refuses all).
func New(token string, hashConcurrency int, roots *hash.Roots, log *slog.Logger, dbPath ...string) *Server {
	s := &Server{
		token:     []byte(token),
		log:       log,
		roots:     roots,
		limiter:   hash.NewLimiter(hashConcurrency, maxQueuedHashes),
		stats:     &hash.Stats{},
		fsStats:   &fsx.Stats{},
		startedAt: time.Now(),
	}
	if len(dbPath) > 0 && dbPath[0] != "" {
		s.dbRead = dbread.NewHandler(dbPath[0], log)
	}
	return s
}

// Handler returns the root handler.
func (s *Server) Handler() http.Handler {
	private := http.NewServeMux()
	private.Handle("POST /v1/hash", &hash.Handler{Limiter: s.limiter, Stats: s.stats, Roots: s.roots, Log: s.log})
	private.Handle("POST /v1/hash-batch", &hash.BatchHandler{Limiter: s.limiter, Stats: s.stats, Roots: s.roots})
	private.Handle("POST /v1/tar-gz", &tarstream.Handler{Roots: s.roots, Log: s.log})
	private.Handle("POST /v1/fs/stat-batch", &fsx.StatBatchHandler{Roots: s.roots, Stats: s.fsStats, Log: s.log})
	private.Handle("POST /v1/fs/walk", &fsx.WalkHandler{Roots: s.roots, Stats: s.fsStats, Log: s.log})
	private.Handle("POST /v1/fs/remove-tree", &fsx.RemoveTreeHandler{Roots: s.roots})
	private.Handle("POST /v1/dbscan", &dbscan.Handler{Log: s.log})
	private.Handle("POST /v1/zip", &zipstream.Handler{Roots: s.roots, Log: s.log})
	private.Handle("POST /v1/faststart", &faststart.Handler{Roots: s.roots, Log: s.log})
	private.Handle("POST /v1/thumb/video", &thumbs.Handler{Roots: s.roots, Log: s.log})
	private.Handle("POST /v1/thumb/image", &thumbs.Handler{Roots: s.roots, Log: s.log, Kind: "image"})
	private.Handle("POST /v1/thumb/audio", &thumbs.Handler{Roots: s.roots, Log: s.log, Kind: "audio"})
	private.Handle("POST /v1/seekbar", &seekbar.Handler{Roots: s.roots, Log: s.log})
	if s.dbRead != nil {
		private.Handle("POST /v1/db/group-aggregates", s.dbRead)
		private.HandleFunc("POST /v1/db/stats", s.dbRead.Stats)
		private.HandleFunc("POST /v1/db/group-stats", s.dbRead.GroupStats)
		private.HandleFunc("POST /v1/db/group-files", s.dbRead.GroupFiles)
		private.HandleFunc("POST /v1/db/group-download-ids", s.dbRead.GroupDownloadIDs)
		private.HandleFunc("POST /v1/db/downloads/all", s.dbRead.AllDownloads)
		private.HandleFunc("POST /v1/db/downloads/group", s.dbRead.DownloadsGroup)
		private.HandleFunc("POST /v1/db/downloads/by-ids", s.dbRead.DownloadsByIDs)
		private.HandleFunc("POST /v1/db/downloads/search", s.dbRead.Search)
		private.HandleFunc("POST /v1/db/share-links", s.dbRead.ShareLinks)
		private.HandleFunc("POST /v1/db/update-history", s.dbRead.UpdateHistory)
		private.HandleFunc("POST /v1/db/nsfw-tiers", s.dbRead.NsfwTiers)
		private.HandleFunc("POST /v1/db/nsfw-histogram", s.dbRead.NsfwHistogram)
		private.HandleFunc("POST /v1/db/nsfw-list", s.dbRead.NsfwList)
		private.HandleFunc("POST /v1/db/nsfw-candidates", s.dbRead.NsfwCandidates)
		private.HandleFunc("POST /v1/db/people", s.dbRead.People)
		private.HandleFunc("POST /v1/db/thumbs-list", s.dbRead.ThumbsList)
		private.HandleFunc("POST /v1/db/seekbar-list", s.dbRead.SeekbarList)
		private.HandleFunc("POST /v1/db/faces-by-download", s.dbRead.FacesByDownload)
		private.HandleFunc("POST /v1/db/person-groups", s.dbRead.PersonGroups)
		private.HandleFunc("POST /v1/db/person-photos", s.dbRead.PersonPhotos)
		private.HandleFunc("POST /v1/db/face-embeddings", s.dbRead.FaceEmbeddings)
		private.HandleFunc("POST /v1/db/ai-counts", s.dbRead.AICounts)
		private.HandleFunc("POST /v1/db/ai-candidates", s.dbRead.AICandidates)
		private.HandleFunc("POST /v1/db/ai-pending", s.dbRead.AIPending)
		private.HandleFunc("POST /v1/db/quality-candidates", s.dbRead.QualityCandidates)
		private.HandleFunc("POST /v1/db/recovery-stats", s.dbRead.RecoveryStats)
		private.HandleFunc("POST /v1/db/cluster-downloads", s.dbRead.ClusterDownloads)
		private.HandleFunc("POST /v1/db/cluster-downloads-since", s.dbRead.ClusterDownloadsSince)
		private.HandleFunc("POST /v1/db/cluster-search", s.dbRead.ClusterSearch)
		private.HandleFunc("POST /v1/db/telegram-media-candidates", s.dbRead.TelegramMediaCandidates)
		private.HandleFunc("POST /v1/db/file-hash-candidates", s.dbRead.FileHashCandidates)
		private.HandleFunc("POST /v1/db/file-name-candidates", s.dbRead.FileNameCandidates)
		private.HandleFunc("POST /v1/db/dedup-stats", s.dbRead.DedupStats)
		private.HandleFunc("POST /v1/db/seekbar-stats", s.dbRead.SeekbarStats)
		private.HandleFunc("POST /v1/db/seekbar-candidates", s.dbRead.SeekbarCandidates)
		private.HandleFunc("POST /v1/db/faststart-candidates", s.dbRead.FaststartCandidates)
		private.HandleFunc("POST /v1/db/faststart-stats", s.dbRead.FaststartStats)
		private.HandleFunc("POST /v1/db/disk-rotator-candidates", s.dbRead.DiskRotatorCandidates)
		private.HandleFunc("POST /v1/db/integrity-candidates", s.dbRead.IntegrityCandidates)
		private.HandleFunc("POST /v1/db/integrity-check", s.dbRead.IntegrityCheck)
		private.HandleFunc("POST /v1/db/dedup-candidates", s.dbRead.DedupCandidates)
		private.HandleFunc("POST /v1/db/dedup-groups", s.dbRead.DedupGroups)
		private.HandleFunc("POST /v1/db/dedup-files", s.dbRead.DedupFiles)
	}
	private.HandleFunc("GET /v1/stats", s.handleStats)
	private.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		hash.WriteError(w, http.StatusNotFound, "ENOTFOUND", "no such route")
	})

	root := http.NewServeMux()
	root.HandleFunc("GET /health", s.handleHealth)
	root.Handle("/", s.requireToken(private))
	return recoverer(s.log, root)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	hash.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"service":  version.Service,
		"version":  version.Version,
		"features": version.Features,
		"pid":      os.Getpid(),
		"go":       runtime.Version(),
		"platform": runtime.GOOS + "/" + runtime.GOARCH,
		"hash": map[string]any{
			"concurrency": s.limiter.Capacity(),
			"roots":       s.roots.Len(),
		},
		"fs": map[string]any{
			"maxBatch": fsx.MaxBatch,
			"fastStat": fsx.FastStatAvailable(),
		},
	})
}

func (s *Server) handleStats(w http.ResponseWriter, _ *http.Request) {
	hash.WriteJSON(w, http.StatusOK, map[string]any{
		"uptimeSec": int64(time.Since(s.startedAt).Seconds()),
		"hash": map[string]any{
			"concurrency": s.limiter.Capacity(),
			"inFlight":    s.limiter.InFlight(),
			"waiting":     s.limiter.Waiting(),
			"completed":   s.stats.Completed.Load(),
			"failed":      s.stats.Failed.Load(),
			"bytes":       s.stats.Bytes.Load(),
			"roots":       s.roots.List(),
		},
		"fs": map[string]any{
			"statCalls": s.fsStats.StatCalls.Load(),
			"statPaths": s.fsStats.StatPaths.Load(),
			"walks":     s.fsStats.Walks.Load(),
			"walkFiles": s.fsStats.WalkFiles.Load(),
		},
	})
}

func (s *Server) requireToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := []byte(r.Header.Get(TokenHeader))
		if len(s.token) == 0 || subtle.ConstantTimeCompare(got, s.token) != 1 {
			hash.WriteError(w, http.StatusUnauthorized, "EAUTH", "missing or wrong "+TokenHeader)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// recoverer turns a handler panic into a 500 instead of a dropped
// connection, and logs it.
func recoverer(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				if log != nil {
					log.Error("handler panic", "path", r.URL.Path, "panic", v)
				}
				hash.WriteError(w, http.StatusInternalServerError, "EINTERNAL", "internal error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}
