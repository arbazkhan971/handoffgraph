package otlp

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// This file is a deliberately small, dependency-free protobuf wire codec.
//
// HandoffGraph keeps a pure-Go, CGO-free, near-zero-dependency posture
// (toml, ulid, modernc sqlite). Pulling in google.golang.org/protobuf plus
// go.opentelemetry.io/proto/otlp to read four message shapes would multiply
// the dependency surface for no interop gain, so the OTLP/protobuf flavor
// hand-rolls its reader exactly like the OTLP/JSON flavor hand-rolls proto3
// JSON tolerance (types.go) and the hosted converter hand-rolls ULIDs.
//
// Everything here is fail-closed: a truncated buffer, an overlong varint, a
// group-encoded field, or a wire type that does not match the schema is an
// error, never a best-effort partial value.

// maxProtoDepth bounds nested-message recursion while decoding. OTLP's
// deepest legitimate shape is request → ResourceSpans → ScopeSpans → Span →
// KeyValue → AnyValue → KeyValueList → KeyValue → …; 32 leaves generous room
// for nested attribute trees (the sanitizer caps those at maxAttrDepth = 10)
// while making a hostile self-nesting payload fail closed instead of
// exhausting the goroutine stack.
const maxProtoDepth = 32

// maxProtoFieldNumber is the largest legal protobuf field number (2^29-1).
const maxProtoFieldNumber = 536870911

// Protobuf wire types.
const (
	wireVarint     = 0
	wireFixed64    = 1
	wireBytes      = 2
	wireStartGroup = 3
	wireEndGroup   = 4
	wireFixed32    = 5
)

var (
	errProtoTruncated = errors.New("protobuf: truncated message")
	errProtoOverflow  = errors.New("protobuf: varint overflows 64 bits")
	errProtoGroup     = errors.New("protobuf: group wire types are not supported")
	errProtoFieldNum  = errors.New("protobuf: illegal field number")
)

// errProtoDepth reports nesting past maxProtoDepth.
var errProtoDepth = fmt.Errorf("protobuf: message nesting exceeds %d levels", maxProtoDepth)

// protoField is one decoded field: its number, its wire type, and its
// payload. Length-delimited payloads alias the input buffer (the decoder
// never mutates its input and copies anything it retains).
type protoField struct {
	num   int
	typ   int
	num64 uint64 // varint / fixed64 / fixed32 payload
	data  []byte // length-delimited payload
}

// varint returns a varint payload, rejecting a schema/wire-type mismatch.
func (f protoField) varint(where string) (uint64, error) {
	if f.typ != wireVarint {
		return 0, fmt.Errorf("protobuf: %s: expected varint, got wire type %d", where, f.typ)
	}
	return f.num64, nil
}

// fixed64 returns a fixed64 payload (also used for double).
func (f protoField) fixed64(where string) (uint64, error) {
	if f.typ != wireFixed64 {
		return 0, fmt.Errorf("protobuf: %s: expected fixed64, got wire type %d", where, f.typ)
	}
	return f.num64, nil
}

// bytes returns a length-delimited payload. The result aliases the caller's
// buffer; callers that retain it must copy.
func (f protoField) bytes(where string) ([]byte, error) {
	if f.typ != wireBytes {
		return nil, fmt.Errorf("protobuf: %s: expected length-delimited, got wire type %d", where, f.typ)
	}
	return f.data, nil
}

// str returns a length-delimited payload as a string (a copy).
func (f protoField) str(where string) (string, error) {
	b, err := f.bytes(where)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// uint32Field returns a varint payload bounded to uint32, the wire type of
// every `dropped_*_count` field in OTLP.
func (f protoField) uint32Field(where string) (int, error) {
	v, err := f.varint(where)
	if err != nil {
		return 0, err
	}
	if v > 1<<31-1 {
		return 0, fmt.Errorf("protobuf: %s: count %d out of range", where, v)
	}
	return int(v), nil
}

// protoReader walks a protobuf message buffer field by field.
type protoReader struct {
	buf []byte
	pos int
}

func (r *protoReader) done() bool { return r.pos >= len(r.buf) }

// next reads one field header plus its payload.
func (r *protoReader) next() (protoField, error) {
	tag, err := r.readVarint()
	if err != nil {
		return protoField{}, err
	}
	num := tag >> 3
	typ := int(tag & 7)
	if num == 0 || num > maxProtoFieldNumber {
		return protoField{}, fmt.Errorf("%w: %d", errProtoFieldNum, num)
	}
	f := protoField{num: int(num), typ: typ}
	switch typ {
	case wireVarint:
		v, err := r.readVarint()
		if err != nil {
			return protoField{}, err
		}
		f.num64 = v
	case wireFixed64:
		v, err := r.readFixed(8)
		if err != nil {
			return protoField{}, err
		}
		f.num64 = v
	case wireFixed32:
		v, err := r.readFixed(4)
		if err != nil {
			return protoField{}, err
		}
		f.num64 = v
	case wireBytes:
		b, err := r.readLenDelim()
		if err != nil {
			return protoField{}, err
		}
		f.data = b
	case wireStartGroup, wireEndGroup:
		// Groups are proto2-only and removed from proto3; OTLP never uses
		// them. Skipping one correctly needs a second parser, so refuse.
		return protoField{}, errProtoGroup
	default:
		return protoField{}, fmt.Errorf("protobuf: unknown wire type %d for field %d", typ, num)
	}
	return f, nil
}

// readVarint decodes a base-128 varint with strict overflow bounds.
func (r *protoReader) readVarint() (uint64, error) {
	var v uint64
	for i := 0; i < 10; i++ {
		if r.pos >= len(r.buf) {
			return 0, errProtoTruncated
		}
		b := r.buf[r.pos]
		r.pos++
		if i == 9 && b > 1 {
			// The 10th byte contributes only bit 63.
			return 0, errProtoOverflow
		}
		v |= uint64(b&0x7f) << (7 * uint(i))
		if b < 0x80 {
			return v, nil
		}
	}
	return 0, errProtoOverflow
}

// readFixed reads n little-endian bytes (n is 4 or 8).
func (r *protoReader) readFixed(n int) (uint64, error) {
	if len(r.buf)-r.pos < n {
		return 0, errProtoTruncated
	}
	b := r.buf[r.pos : r.pos+n]
	r.pos += n
	if n == 4 {
		return uint64(binary.LittleEndian.Uint32(b)), nil
	}
	return binary.LittleEndian.Uint64(b), nil
}

// readLenDelim reads a length-prefixed payload, bounded by what is left.
func (r *protoReader) readLenDelim() ([]byte, error) {
	n, err := r.readVarint()
	if err != nil {
		return nil, err
	}
	remaining := uint64(len(r.buf) - r.pos)
	if n > remaining {
		return nil, errProtoTruncated
	}
	b := r.buf[r.pos : r.pos+int(n)]
	r.pos += int(n)
	return b, nil
}

// forEachField iterates every field of one message buffer. Fields the
// callback does not recognize are simply skipped, which is how protobuf
// forward compatibility works: a newer OTLP emitter may add fields and this
// decoder must ignore them rather than reject the batch.
func forEachField(buf []byte, fn func(protoField) error) error {
	r := &protoReader{buf: buf}
	for !r.done() {
		f, err := r.next()
		if err != nil {
			return err
		}
		if err := fn(f); err != nil {
			return err
		}
	}
	return nil
}

// --- encoding -------------------------------------------------------------
//
// Just enough of the writer side to answer with a protobuf
// ExportTraceServiceResponse (and, in tests, to build the binary fixture from
// a struct literal without going anywhere near the decoder).

// protoAppendVarint appends a base-128 varint.
func protoAppendVarint(dst []byte, v uint64) []byte {
	for v >= 0x80 {
		dst = append(dst, byte(v)|0x80)
		v >>= 7
	}
	return append(dst, byte(v))
}

// protoAppendTag appends a field header.
func protoAppendTag(dst []byte, num, typ int) []byte {
	return protoAppendVarint(dst, uint64(num)<<3|uint64(typ))
}

// protoAppendLenDelim appends a length-delimited field (message/bytes).
func protoAppendLenDelim(dst []byte, num int, payload []byte) []byte {
	dst = protoAppendTag(dst, num, wireBytes)
	dst = protoAppendVarint(dst, uint64(len(payload)))
	return append(dst, payload...)
}

// protoAppendString appends a string field.
func protoAppendString(dst []byte, num int, s string) []byte {
	dst = protoAppendTag(dst, num, wireBytes)
	dst = protoAppendVarint(dst, uint64(len(s)))
	return append(dst, s...)
}

// protoAppendVarintField appends a varint-typed field (int64/uint32/enum).
func protoAppendVarintField(dst []byte, num int, v uint64) []byte {
	dst = protoAppendTag(dst, num, wireVarint)
	return protoAppendVarint(dst, v)
}

// protoAppendFixed64 appends a fixed64-typed field (also used for double).
func protoAppendFixed64(dst []byte, num int, v uint64) []byte {
	dst = protoAppendTag(dst, num, wireFixed64)
	var b [8]byte
	binary.LittleEndian.PutUint64(b[:], v)
	return append(dst, b[:]...)
}
