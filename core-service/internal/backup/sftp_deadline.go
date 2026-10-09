package backup

import (
	"encoding/binary"
	"errors"
	"io"
	"net"
	"sync"
	"time"
)

// Observe framing only; pkg/sftp still owns protocol parsing and request IDs.
// Retain nine header bytes, never a packet/file payload. Requests become pending
// before writing their complete header; only a complete response releases one.
type sftpFrameObserver struct {
	header    [9]byte
	have      int
	remaining uint32
	inPayload bool
	typeCode  byte
	id        uint32
}

func (o *sftpFrameObserver) observe(b []byte, start, end func(byte, uint32)) error {
	for len(b) > 0 {
		if !o.inPayload {
			n := copy(o.header[o.have:], b)
			o.have += n
			b = b[n:]
			if o.have < 9 {
				continue
			}
			length := binary.BigEndian.Uint32(o.header[:4])
			if length < 5 {
				return errors.New("invalid SFTP packet length")
			}
			o.typeCode = o.header[4]
			o.id = binary.BigEndian.Uint32(o.header[5:])
			if o.typeCode == 1 || o.typeCode == 2 {
				o.id = 0
			}
			o.remaining = length - 5
			o.inPayload = true
			if start != nil {
				start(o.typeCode, o.id)
			}
		}
		if o.remaining > 0 {
			n := min(uint32(len(b)), o.remaining)
			b = b[n:]
			o.remaining -= n
		}
		if o.remaining == 0 {
			if end != nil {
				end(o.typeCode, o.id)
			}
			o.have = 0
			o.inPayload = false
		}
	}
	return nil
}

type sftpDeadlineChannel struct {
	io.ReadWriteCloser
	raw                   net.Conn
	timeout               time.Duration
	mu                    sync.Mutex
	pending               map[uint32]struct{}
	readFrame, writeFrame sftpFrameObserver
}

func newSFTPDeadlineChannel(channel io.ReadWriteCloser, raw net.Conn, timeout time.Duration) *sftpDeadlineChannel {
	return &sftpDeadlineChannel{ReadWriteCloser: channel, raw: raw, timeout: timeout, pending: map[uint32]struct{}{}}
}
func (c *sftpDeadlineChannel) deadline() {
	deadline := time.Time{}
	if len(c.pending) > 0 {
		deadline = time.Now().Add(c.timeout)
	}
	_ = c.raw.SetReadDeadline(deadline)
}
func (c *sftpDeadlineChannel) Write(b []byte) (int, error) {
	if err := c.writeFrame.observe(b, func(_ byte, id uint32) {
		c.mu.Lock()
		c.pending[id] = struct{}{}
		c.deadline()
		c.mu.Unlock()
	}, nil); err != nil {
		return 0, err
	}
	return c.ReadWriteCloser.Write(b)
}
func (c *sftpDeadlineChannel) Read(b []byte) (int, error) {
	n, err := c.ReadWriteCloser.Read(b)
	if n > 0 {
		parseErr := c.readFrame.observe(b[:n], nil, func(_ byte, id uint32) { c.mu.Lock(); delete(c.pending, id); c.mu.Unlock() })
		c.mu.Lock()
		c.deadline()
		c.mu.Unlock()
		if parseErr != nil {
			return n, parseErr
		}
	}
	return n, err
}
