// Package logx is a tiny structured logger. text format prints
// timestamped human-readable lines; json format emits one JSON object
// per record. Both share the same level filter.
package logx

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

type Level int

const (
	LevelDebug Level = iota
	LevelInfo
	LevelWarn
	LevelError
)

func ParseLevel(s string) Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return LevelDebug
	case "warn", "warning":
		return LevelWarn
	case "error", "err":
		return LevelError
	default:
		return LevelInfo
	}
}

type Logger struct {
	mu     sync.Mutex
	out    io.Writer
	level  Level
	asJSON bool
}

func New(level, format string) *Logger {
	return &Logger{
		out:    os.Stderr,
		level:  ParseLevel(level),
		asJSON: strings.EqualFold(format, "json"),
	}
}

func (l *Logger) Debug(msg string, kv ...any) { l.emit(LevelDebug, msg, kv) }
func (l *Logger) Info(msg string, kv ...any)  { l.emit(LevelInfo, msg, kv) }
func (l *Logger) Warn(msg string, kv ...any)  { l.emit(LevelWarn, msg, kv) }
func (l *Logger) Error(msg string, kv ...any) { l.emit(LevelError, msg, kv) }

func (l *Logger) emit(lvl Level, msg string, kv []any) {
	if lvl < l.level {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.asJSON {
		rec := map[string]any{
			"ts":    time.Now().UTC().Format(time.RFC3339Nano),
			"level": levelName(lvl),
			"msg":   msg,
		}
		for i := 0; i+1 < len(kv); i += 2 {
			if k, ok := kv[i].(string); ok {
				rec[k] = kv[i+1]
			}
		}
		_ = json.NewEncoder(l.out).Encode(rec)
		return
	}
	ts := time.Now().Format("2006-01-02 15:04:05.000")
	var pairs strings.Builder
	for i := 0; i+1 < len(kv); i += 2 {
		fmt.Fprintf(&pairs, " %v=%v", kv[i], kv[i+1])
	}
	fmt.Fprintf(l.out, "%s %-5s %s%s\n", ts, levelName(lvl), msg, pairs.String())
}

func levelName(lvl Level) string {
	switch lvl {
	case LevelDebug:
		return "DEBUG"
	case LevelWarn:
		return "WARN"
	case LevelError:
		return "ERROR"
	default:
		return "INFO"
	}
}
