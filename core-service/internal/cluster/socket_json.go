package cluster

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
)

// The released wire signature hashes JSON.stringify(payload || {}). Compact
// alone is insufficient: numbers, escaped strings and integer property order
// must be normalized after parsing. Preserve other property insertion order.
func socketJSON(raw []byte) ([]byte, error) {
	if len(raw) > 512<<10 || !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, errors.New("invalid socket JSON")
	}
	p := socketJSONParser{raw: raw}
	v, err := p.value(0)
	if err != nil {
		return nil, err
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || bytes.Equal(v, []byte("false")) || bytes.Equal(v, []byte("0")) || bytes.Equal(v, []byte(`""`)) {
		return []byte("{}"), nil
	}
	return v, nil
}

type socketJSONParser struct {
	raw []byte
	pos int
}
type socketProperty struct {
	key, value []byte
	index      uint64
}

func (p *socketJSONParser) space() {
	for p.pos < len(p.raw) {
		switch p.raw[p.pos] {
		case ' ', '\t', '\r', '\n':
			p.pos++
		default:
			return
		}
	}
}
func (p *socketJSONParser) value(depth int) ([]byte, error) {
	if depth > 64 {
		return nil, errors.New("socket JSON nesting limit")
	}
	p.space()
	switch p.raw[p.pos] {
	case '"':
		return p.quoted(), nil
	case '{':
		p.pos++
		p.space()
		var props []socketProperty
		seen := make(map[string]int)
		for p.raw[p.pos] != '}' {
			key := p.quoted()
			p.space()
			p.pos++ // colon, validated by json.Valid
			v, err := p.value(depth + 1)
			if err != nil {
				return nil, err
			}
			if i, ok := seen[string(key)]; ok {
				props[i].value = v
			} else {
				index := uint64(math.MaxUint64)
				if n, err := strconv.ParseUint(string(key[1:len(key)-1]), 10, 32); err == nil && n < math.MaxUint32 && strconv.FormatUint(n, 10) == string(key[1:len(key)-1]) {
					index = n
				}
				seen[string(key)] = len(props)
				props = append(props, socketProperty{key, v, index})
			}
			p.space()
			if p.raw[p.pos] == ',' {
				p.pos++
				p.space()
			}
		}
		p.pos++
		sort.SliceStable(props, func(i, j int) bool { return props[i].index < props[j].index })
		out := []byte{'{'}
		for i, prop := range props {
			if i > 0 {
				out = append(out, ',')
			}
			out = append(out, prop.key...)
			out = append(out, ':')
			out = append(out, prop.value...)
		}
		return append(out, '}'), nil
	case '[':
		p.pos++
		p.space()
		out := []byte{'['}
		for p.raw[p.pos] != ']' {
			v, err := p.value(depth + 1)
			if err != nil {
				return nil, err
			}
			out = append(out, v...)
			p.space()
			if p.raw[p.pos] == ',' {
				out = append(out, ',')
				p.pos++
				p.space()
			}
		}
		p.pos++
		return append(out, ']'), nil
	default:
		start := p.pos
		for p.pos < len(p.raw) && !bytes.ContainsRune([]byte(" \t\r\n,]}"), rune(p.raw[p.pos])) {
			p.pos++
		}
		v := p.raw[start:p.pos]
		if v[0] == 'n' || v[0] == 't' || v[0] == 'f' {
			return v, nil
		}
		n, err := strconv.ParseFloat(string(v), 64)
		if math.IsInf(n, 0) {
			return []byte("null"), nil
		}
		if err != nil {
			return nil, err
		}
		if n == 0 {
			return []byte("0"), nil
		}
		return json.Marshal(n) // shortest round-trip binary64, ECMAScript exponent thresholds
	}
}

func (p *socketJSONParser) hexRune() rune {
	n, _ := strconv.ParseUint(string(p.raw[p.pos:p.pos+4]), 16, 16)
	p.pos += 4
	return rune(n)
}
func (p *socketJSONParser) quoted() []byte {
	p.pos++
	out := []byte{'"'}
	for p.raw[p.pos] != '"' {
		r, size := utf8.DecodeRune(p.raw[p.pos:])
		p.pos += size
		if r == '\\' {
			e := p.raw[p.pos]
			p.pos++
			switch e {
			case 'u':
				r = p.hexRune()
				if r >= 0xd800 && r <= 0xdbff && p.pos+6 <= len(p.raw) && p.raw[p.pos] == '\\' && p.raw[p.pos+1] == 'u' {
					n, _ := strconv.ParseUint(string(p.raw[p.pos+2:p.pos+6]), 16, 16)
					if n >= 0xdc00 && n <= 0xdfff {
						p.pos += 6
						r = utf16.DecodeRune(r, rune(n))
					}
				}
			case 'b':
				r = '\b'
			case 'f':
				r = '\f'
			case 'n':
				r = '\n'
			case 'r':
				r = '\r'
			case 't':
				r = '\t'
			default:
				r = rune(e)
			}
		}
		switch r {
		case '"', '\\':
			out = append(out, '\\', byte(r))
		case '\b':
			out = append(out, '\\', 'b')
		case '\f':
			out = append(out, '\\', 'f')
		case '\n':
			out = append(out, '\\', 'n')
		case '\r':
			out = append(out, '\\', 'r')
		case '\t':
			out = append(out, '\\', 't')
		default:
			if r < 32 || r >= 0xd800 && r <= 0xdfff {
				const hex = "0123456789abcdef"
				out = append(out, '\\', 'u', hex[(r>>12)&15], hex[(r>>8)&15], hex[(r>>4)&15], hex[r&15])
			} else {
				out = utf8.AppendRune(out, r)
			}
		}
	}
	p.pos++
	return append(out, '"')
}
