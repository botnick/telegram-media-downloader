package app

import (
	"math"
	"strings"
)

func clampConfigInt(value any, lo, hi, fallback int64) int64 {
	n := int64(number(value, float64(fallback)))
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

func configBlock(root map[string]any, key string) map[string]any {
	if block, ok := root[key].(map[string]any); ok {
		return block
	}
	block := map[string]any{}
	root[key] = block
	return block
}

func sanitizeAdvancedConfig(a map[string]any) {
	d := configBlock(a, "downloader")
	d["minConcurrency"] = clampConfigInt(d["minConcurrency"], 1, 100, 3)
	d["maxConcurrency"] = clampConfigInt(d["maxConcurrency"], 1, 100, 20)
	if d["maxConcurrency"].(int64) < d["minConcurrency"].(int64) {
		d["maxConcurrency"] = d["minConcurrency"]
	}
	d["scalerIntervalSec"] = clampConfigInt(d["scalerIntervalSec"], 1, 600, 5)
	d["idleSleepMs"] = clampConfigInt(d["idleSleepMs"], 50, 10000, 200)

	h := configBlock(a, "history")
	h["backpressureCap"] = clampConfigInt(h["backpressureCap"], 10, 100000, 500)
	h["backpressureMaxWaitMs"] = clampConfigInt(h["backpressureMaxWaitMs"], 5000, 3600000, 900000)
	h["shortBreakEveryN"] = clampConfigInt(h["shortBreakEveryN"], 0, 100000, 100)
	h["longBreakEveryN"] = clampConfigInt(h["longBreakEveryN"], 0, 1000000, 1000)
	h["retentionDays"] = clampConfigInt(h["retentionDays"], 1, 3650, 30)
	h["autoFirstBackfill"] = h["autoFirstBackfill"] != false
	h["autoFirstLimit"] = clampConfigInt(h["autoFirstLimit"], 0, 10000, 100)
	h["autoCatchUp"] = h["autoCatchUp"] != false
	h["autoCatchUpThreshold"] = clampConfigInt(h["autoCatchUpThreshold"], 1, 100000, 5)
	h["batchInsertSize"] = clampConfigInt(h["batchInsertSize"], 1, 500, 50)
	h["batchInsertMaxAgeMs"] = clampConfigInt(h["batchInsertMaxAgeMs"], 100, 60000, 1000)

	dr := configBlock(a, "diskRotator")
	dr["sweepBatch"] = clampConfigInt(dr["sweepBatch"], 1, 1000, 50)
	dr["maxDeletesPerSweep"] = clampConfigInt(dr["maxDeletesPerSweep"], 1, 100000, 5000)
	it := configBlock(a, "integrity")
	it["intervalMin"] = clampConfigInt(it["intervalMin"], 1, 10080, 60)
	it["batchSize"] = clampConfigInt(it["batchSize"], 1, 1024, 64)
	w := configBlock(a, "web")
	w["sessionTtlDays"] = clampConfigInt(w["sessionTtlDays"], 1, 365, 30)

	sh := configBlock(a, "share")
	sh["ttlMinSec"] = clampConfigInt(sh["ttlMinSec"], 1, 315360000, 60)
	sh["ttlMaxSec"] = clampConfigInt(sh["ttlMaxSec"], sh["ttlMinSec"].(int64), 315360000, 7776000)
	sh["ttlDefaultSec"] = clampConfigInt(sh["ttlDefaultSec"], sh["ttlMinSec"].(int64), sh["ttlMaxSec"].(int64), 604800)
	sh["rateLimitWindowMs"] = clampConfigInt(sh["rateLimitWindowMs"], 1000, 3600000, 60000)
	sh["rateLimitMax"] = clampConfigInt(sh["rateLimitMax"], 1, 100000, 60)

	ns := configBlock(a, "nsfw")
	ns["enabled"] = ns["enabled"] == true
	ns["preload"] = ns["preload"] == true
	ns["blocklistEnabled"] = ns["blocklistEnabled"] == true
	threshold := number(ns["threshold"], 0.6)
	if threshold < 0.1 {
		threshold = 0.1
	}
	if threshold > 0.99 {
		threshold = 0.99
	}
	ns["threshold"] = math.Round(threshold*1000) / 1000
	ns["concurrency"] = clampConfigInt(ns["concurrency"], 1, 4, 1)
	ns["batchSize"] = clampConfigInt(ns["batchSize"], 10, 500, 50)
	ns["videoMaxTiles"] = clampConfigInt(ns["videoMaxTiles"], 3, 200, 48)
	if text, ok := ns["model"].(string); !ok || strings.TrimSpace(text) == "" {
		ns["model"] = "AdamCodd/vit-base-nsfw-detector"
	} else {
		ns["model"] = strings.TrimSpace(text)
	}
	allowedDType := map[string]bool{"q8": true, "fp16": true, "fp32": true, "q4": true}
	dtype, _ := ns["dtype"].(string)
	dtype = strings.ToLower(strings.TrimSpace(dtype))
	if !allowedDType[dtype] {
		dtype = "q8"
	}
	ns["dtype"] = dtype
	ns["cacheDir"] = stringOr(ns["cacheDir"], "data/models")
	ns["pathMap"] = stringOr(ns["pathMap"], "")
	ns["sidecarUrl"] = stringOr(ns["sidecarUrl"], "")
	if token, ok := ns["apiToken"].(string); ok {
		ns["apiToken"] = strings.TrimSpace(token)
	} else {
		ns["apiToken"] = ""
	}
	allowedTypes := map[string]bool{"photo": true, "video": true, "sticker": true, "document": true}
	ns["fileTypes"] = cleanTypes(ns["fileTypes"], allowedTypes, []any{"photo"})

	thumbs := configBlock(a, "thumbs")
	thumbs["hwaccel"] = allowedThumbAccel(stringOr(thumbs["hwaccel"], ""))
	thumbs["warnMisses"] = thumbs["warnMisses"] != false
	thumbs["autoOnDownload"] = thumbs["autoOnDownload"] != false

	sk := configBlock(a, "seekbar")
	sk["enabled"] = sk["enabled"] != false
	sk["autoOnDownload"] = sk["autoOnDownload"] != false
	sk["intervalSec"] = clampConfigInt(sk["intervalSec"], 1, 60, 4)
	sk["tileWidth"] = clampConfigInt(sk["tileWidth"], 64, 480, 160)
	sk["columns"] = clampConfigInt(sk["columns"], 2, 30, 10)
	sk["maxTiles"] = clampConfigInt(sk["maxTiles"], 12, 1000, 240)
	sk["quality"] = clampConfigInt(sk["quality"], 10, 100, 75)
	sk["concurrency"] = clampConfigInt(sk["concurrency"], 1, 16, 4)
	sk["maxRetries"] = clampConfigInt(sk["maxRetries"], 0, 10, 3)
	format := strings.ToLower(strings.TrimSpace(stringOr(sk["format"], "")))
	if format != "webp" && format != "jpeg" {
		format = "webp"
	}
	sk["format"] = format
	overwrite := strings.ToLower(strings.TrimSpace(stringOr(sk["overwrite"], "")))
	if overwrite != "never" && overwrite != "if-changed" && overwrite != "always" {
		overwrite = "if-changed"
	}
	sk["overwrite"] = overwrite
	sk["hwaccel"] = allowedSeekbarAccel(sk["hwaccel"])
	sk["sidecarUrl"] = stringOr(sk["sidecarUrl"], "")
	sk["pathMap"] = stringOr(sk["pathMap"], "")
	if token, ok := sk["apiToken"].(string); ok {
		sk["apiToken"] = strings.TrimSpace(token)
	} else {
		sk["apiToken"] = ""
	}

	ai := configBlock(a, "ai")
	ai["enabled"] = ai["enabled"] == true
	ai["semanticSearch"] = ai["semanticSearch"] != false
	ai["autoTags"] = ai["autoTags"] != false
	ai["faceClustering"] = ai["faceClustering"] != false
	ai["model"] = stringOr(ai["model"], "Xenova/clip-vit-base-patch32")
	ai["searchModel"] = stringOr(ai["searchModel"], "")
	ai["tagsModel"] = stringOr(ai["tagsModel"], "")
	ai["facesModel"] = stringOr(ai["facesModel"], "")
	ai["dtype"] = "q8"
	ai["indexConcurrency"] = clampConfigInt(ai["indexConcurrency"], 1, 4, 1)
	ai["batchSize"] = clampConfigInt(ai["batchSize"], 1, 200, 16)
	ai["maxTagsPerImage"] = clampConfigInt(ai["maxTagsPerImage"], 1, 20, 5)
	tagsMode := strings.ToLower(stringOr(ai["tagsMode"], ""))
	if tagsMode != "auto" && tagsMode != "zero-shot" && tagsMode != "classifier" {
		tagsMode = "auto"
	}
	ai["tagsMode"] = tagsMode
	ai["minTagScore"] = clampFloat(number(ai["minTagScore"], 0.2), 0, 1, 0.2)
	// Keep the released dashboard's conservative face defaults. The flat
	// aliases remain for older readers while the nested block is canonical.
	ai["facesEpsilon"] = 1.05
	ai["facesMinPoints"] = clampConfigInt(ai["facesMinPoints"], 2, 50, 2)
	ai["fileTypes"] = cleanTypes(ai["fileTypes"], map[string]bool{"photo": true}, []any{"photo"})
	ai["tagLabels"] = cleanLabels(ai["tagLabels"])
	if len(ai["tagLabels"].([]any)) == 0 {
		ai["tagLabels"] = []any{"portrait", "landscape", "group_photo", "selfie", "food", "document", "screenshot", "meme", "logo", "indoor", "outdoor", "animal", "pet", "vehicle", "building", "art", "text"}
	}
	ai["hfToken"] = stringOr(ai["hfToken"], "")
	ai["federateFaces"] = ai["federateFaces"] == true
	detector := strings.ToLower(stringOr(ai["facesDetector"], ""))
	if detector != "tiny" && detector != "ssd" {
		detector = "tiny"
	}
	ai["facesDetector"] = detector
	ai["autoScan"] = normalizeAutoScan(ai["autoScan"])
	ai["autoScanIntervalMs"] = clampConfigInt(ai["autoScanIntervalMs"], 5000, 3600000, 60000)
	ai["autoScanBatchSize"] = clampConfigInt(ai["autoScanBatchSize"], 1, 200, 10)
	ai["autoScanQueueCeiling"] = clampConfigInt(ai["autoScanQueueCeiling"], 1, 200, 50)
	faces := configBlock(ai, "faces")
	faces["sidecarTokenSet"] = false
	if token, ok := faces["sidecarToken"].(string); ok {
		faces["sidecarToken"] = strings.TrimSpace(token)
		delete(faces, "sidecarTokenSet")
	}
}

func stringOr(value any, fallback string) string {
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	return fallback
}

func clampFloat(value, lo, hi, fallback float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		value = fallback
	}
	if value < lo {
		return lo
	}
	if value > hi {
		return hi
	}
	return math.Round(value*1000) / 1000
}

func cleanTypes(value any, allowed map[string]bool, fallback []any) []any {
	input, _ := value.([]any)
	seen := map[string]bool{}
	out := make([]any, 0, len(input))
	for _, raw := range input {
		text := strings.ToLower(stringOr(raw, ""))
		if text != "" && allowed[text] && !seen[text] {
			seen[text] = true
			out = append(out, text)
		}
	}
	if len(out) == 0 {
		return append([]any(nil), fallback...)
	}
	return out
}

func cleanLabels(value any) []any {
	input, _ := value.([]any)
	seen := map[string]bool{}
	out := make([]any, 0, len(input))
	for _, raw := range input {
		text := strings.TrimSpace(stringOr(raw, ""))
		if text != "" && !seen[text] {
			seen[text] = true
			out = append(out, text)
		}
		if len(out) >= 200 {
			break
		}
	}
	return out
}

func normalizeAutoScan(value any) string {
	if value == true {
		return "running"
	}
	if value == false {
		return "idle"
	}
	text := strings.ToLower(stringOr(value, "idle"))
	if text == "running" || text == "paused" || text == "idle" {
		return text
	}
	return "idle"
}

func allowedThumbAccel(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "vaapi", "qsv", "cuda", "videotoolbox", "d3d11va", "dxva2":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return ""
	}
}

func allowedSeekbarAccel(value any) any {
	text := strings.ToLower(strings.TrimSpace(stringOr(value, "")))
	switch text {
	case "auto", "none", "cuda", "vaapi", "qsv", "d3d11va", "dxva2", "videotoolbox", "v4l2m2m":
		return text
	default:
		return nil
	}
}
