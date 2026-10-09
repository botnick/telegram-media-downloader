package telegram

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"testing"

	"github.com/gotd/td/bin"
	gotd "github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/downloader"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

type downloadTestClient struct {
	pool    *downloadTestPool
	target  int
	exports int
	failure error
}

func (*downloadTestClient) Config() tg.Config { return tg.Config{ThisDC: 5} }
func (c *downloadTestClient) Pool(int64) (gotd.CloseInvoker, error) {
	c.target = 5
	return c.pool, c.failure
}
func (c *downloadTestClient) DC(_ context.Context, dc int, _ int64) (gotd.CloseInvoker, error) {
	c.exports++
	c.target = dc
	if dc == 5 {
		return nil, tgerr.New(400, "DC_ID_INVALID")
	}
	return c.pool, c.failure
}

type downloadTestPool struct {
	data           []byte
	corrupt        bool
	closed         bool
	hashes, chunks int
}

func (p *downloadTestPool) Close() error { p.closed = true; return nil }
func (p *downloadTestPool) Invoke(ctx context.Context, in bin.Encoder, out bin.Decoder) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	switch req := in.(type) {
	case *tg.UploadGetFileHashesRequest:
		p.hashes++
		if req.Offset == 0 {
			sum := sha256.Sum256(p.data)
			if p.corrupt {
				sum[0] ^= 255
			}
			out.(*tg.FileHashVector).Elems = []tg.FileHash{{Offset: 0, Limit: 4096, Hash: sum[:]}}
		}
	case *tg.UploadGetFileRequest:
		p.chunks++
		out.(*tg.UploadFileBox).File = &tg.UploadFile{Type: &tg.StorageFileJpeg{}, Bytes: p.data}
	default:
		return errors.New("unexpected RPC")
	}
	return nil
}
func TestDownloadUsesAuthorizedHomeDCPoolAndVerifiesBytes(t *testing.T) {
	for _, dc := range []int{5, 2} {
		p := &downloadTestPool{data: []byte("verified transfer")}
		c := &downloadTestClient{pool: p}
		var out bytes.Buffer
		err := downloadMedia(context.Background(), c, Attachment{DC: dc, Location: &tg.InputPeerPhotoFileLocation{Peer: &tg.InputPeerSelf{}, PhotoID: 42}}, &out)
		if err != nil {
			t.Fatalf("dc=%d: %v", dc, err)
		}
		if !bytes.Equal(out.Bytes(), p.data) || !p.closed || p.hashes == 0 || p.chunks != 1 || c.target != dc {
			t.Fatalf("invalid transfer dc=%d pool=%+v", dc, p)
		}
		if dc == 5 && c.exports != 0 {
			t.Fatal("exported authorization back to home DC")
		}
		if dc == 2 && c.exports != 1 {
			t.Fatal("foreign DC did not receive authorization")
		}
	}
}
func TestDownloadRetainsIntegrityAndTransportErrors(t *testing.T) {
	p := &downloadTestPool{data: []byte("corrupted bytes"), corrupt: true}
	c := &downloadTestClient{pool: p}
	var out bytes.Buffer
	a := Attachment{DC: 5, Location: &tg.InputPeerPhotoFileLocation{Peer: &tg.InputPeerSelf{}, PhotoID: 42}}
	if err := downloadMedia(context.Background(), c, a, &out); !errors.Is(err, downloader.ErrHashMismatch) {
		t.Fatalf("integrity error=%v", err)
	}
	if out.Len() != 0 || !p.closed {
		t.Fatal("published corrupt data or leaked pool")
	}
	failure := errors.New("transport refused")
	c = &downloadTestClient{failure: failure}
	if err := downloadMedia(context.Background(), c, a, &out); !errors.Is(err, failure) || c.exports != 0 {
		t.Fatalf("unexpected alternate transport: %v", err)
	}
}
