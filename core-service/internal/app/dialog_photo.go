package app

import (
	"bytes"
	"context"
	"errors"
	"image/jpeg"
	"sync"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
)

type dialogPhotoFlight struct {
	done  chan struct{}
	found bool
	err   error
}

type dialogPhotoCache struct {
	mu      sync.Mutex
	slots   chan struct{}
	flights map[string]*dialogPhotoFlight
	closed  bool
	wg      sync.WaitGroup
}

func (a *App) closeDialogPhotos() {
	a.dialogPhotos.mu.Lock()
	a.dialogPhotos.closed = true
	a.dialogPhotos.mu.Unlock()
	a.dialogPhotos.wg.Wait()
}

// HTTP requests own the work: no detached downloads, at most four transports,
// and one in-flight download per chat. A canceled browser request releases it.
func (a *App) ensureDialogPhoto(ctx context.Context, id string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if a.ctx != nil {
		if err := a.ctx.Err(); err != nil {
			return false, err
		}
		stop := context.AfterFunc(a.ctx, cancel)
		defer stop()
	}
	cache := &a.dialogPhotos
	cache.mu.Lock()
	if cache.closed {
		cache.mu.Unlock()
		return false, context.Canceled
	}
	if active := cache.flights[id]; active != nil {
		cache.mu.Unlock()
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-active.done:
			return active.found, active.err
		}
	}
	if len(cache.flights) >= 128 {
		cache.mu.Unlock()
		return false, errors.New("profile photo queue is full")
	}
	if cache.slots == nil {
		cache.slots = make(chan struct{}, 4)
		cache.flights = make(map[string]*dialogPhotoFlight)
	}
	flight := &dialogPhotoFlight{done: make(chan struct{})}
	cache.flights[id] = flight
	cache.wg.Add(1)
	cache.mu.Unlock()
	defer func() {
		cache.mu.Lock()
		delete(cache.flights, id)
		close(flight.done)
		cache.mu.Unlock()
		cache.wg.Done()
	}()
	select {
	case cache.slots <- struct{}{}:
		defer func() { <-cache.slots }()
	case <-ctx.Done():
		flight.err = ctx.Err()
		return false, flight.err
	}
	// Another request or metadata refresh may have published while we waited.
	if a.cachedMetadataPhoto(id) != nil {
		flight.found = true
		return true, nil
	}
	flight.found, flight.err = a.fetchDialogPhoto(ctx, id)
	return flight.found, flight.err
}

func (a *App) fetchDialogPhoto(ctx context.Context, id string) (bool, error) {
	// Browsing already connected the saved account. Hold the same run lease so
	// an idle-job drain cannot stop it halfway through an image request.
	a.monitorOp.Lock()
	epoch, err := a.urlPurgeCheckpoint()
	var session *engine.DialogSession
	if err == nil {
		session, err = a.monitor.OpenDialogs(ctx)
	}
	a.monitorOp.Unlock()
	if err != nil {
		return false, err
	}
	defer session.Close()
	buffer := new(photoBuffer)
	found, err := session.DownloadPhoto(id, buffer)
	if err != nil {
		return false, err
	}
	if !found {
		if buffer.Len() != 0 {
			return false, errors.New("photo transport returned bytes without a photo")
		}
		return false, nil
	}
	config, err := jpeg.DecodeConfig(bytes.NewReader(buffer.Bytes()))
	if err != nil || config.Width <= 0 || config.Height <= 0 || config.Width > 4096 || config.Height > 4096 {
		return false, errors.New("invalid Telegram profile photo")
	}
	if _, err = jpeg.Decode(bytes.NewReader(buffer.Bytes())); err != nil {
		return false, err
	}
	a.mediaMu.RLock()
	defer a.mediaMu.RUnlock()
	if err = session.Err(); err != nil {
		return false, err
	}
	if err = a.mediaWritable(ctx); err != nil {
		return false, err
	}
	if err = a.checkURLPurge(epoch); err != nil {
		return false, err
	}
	if err = a.publishMetadataPhoto(session.Context(), id, buffer.Bytes(), true); err != nil {
		return false, err
	}
	return true, nil
}
