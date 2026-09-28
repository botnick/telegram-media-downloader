//go:build windows

package fsx

import (
	"strings"
	"syscall"
	"unsafe"
)

// Win32 / NT constants used below (winnt.h, ntstatus.h, winioctl.h).
const (
	fileReadAttributes = 0x0080
	fileListDirectory  = 0x0001
	synchronize        = 0x00100000
	shareAll           = syscall.FILE_SHARE_READ | syscall.FILE_SHARE_WRITE | syscall.FILE_SHARE_DELETE

	attrDirectory    = 0x00000010
	attrDevice       = 0x00000040
	attrReparsePoint = 0x00000400

	fileDeviceNull = 0x00000015

	errorFileNotFound     = 2
	errorPathNotFound     = 3
	errorAccessDenied     = 5
	errorNotReady         = 21
	errorSharingViolation = 32
	errorBadNetName       = 67
	errorInvalidName      = 123

	statusSuccess          = 0x00000000
	statusBufferOverflow   = 0x80000005
	statusNoMoreFiles      = 0x80000006
	statusInvalidParameter = 0xC000000D
	statusNotImplemented   = 0xC0000002

	fileDirectoryInformation       = 1
	fileAllInformation             = 18
	fileIDFullDirectoryInformation = 38
	classFsVolumeInformation       = 1
	classFsDeviceInformation       = 4

	fileStatBasicByNameInfo = 3

	winToUnixTickOffset = 116444736000000000
	ticksPerSec         = 10000000
	nsecPerTick         = 100
)

var (
	modkernel32 = syscall.NewLazyDLL("kernel32.dll")
	modntdll    = syscall.NewLazyDLL("ntdll.dll")

	procGetModuleHandleW             = modkernel32.NewProc("GetModuleHandleW")
	procNtQueryInformationFile       = modntdll.NewProc("NtQueryInformationFile")
	procNtQueryVolumeInformationFile = modntdll.NewProc("NtQueryVolumeInformationFile")
	procNtQueryDirectoryFile         = modntdll.NewProc("NtQueryDirectoryFile")
	procRtlNtStatusToDosError        = modntdll.NewProc("RtlNtStatusToDosError")

	// GetFileInformationByName (Windows 11 24H2+), looked up the way
	// libuv's winapi.c does: through the api-ms-win-core-file-l2-1-4 API
	// set. 0 = not available, every stat takes the CreateFile path.
	getFileInformationByName uintptr
)

func init() {
	name, _ := syscall.UTF16PtrFromString("api-ms-win-core-file-l2-1-4.dll")
	h, _, _ := procGetModuleHandleW.Call(uintptr(unsafe.Pointer(name)))
	if h != 0 {
		if p, err := syscall.GetProcAddress(syscall.Handle(h), "GetFileInformationByName"); err == nil {
			getFileInformationByName = p
		}
	}
}

// FastStatAvailable reports whether GetFileInformationByName is used.
func FastStatAvailable() bool { return getFileInformationByName != 0 }

type ioStatusBlock struct {
	Status      uintptr // NTSTATUS in the low 32 bits (union with a pointer)
	Information uintptr
}

func (b *ioStatusBlock) status() uint32 { return uint32(b.Status) }

type unicodeString struct {
	Length        uint16
	MaximumLength uint16
	Buffer        *uint16
}

// FILE_STAT_BASIC_INFORMATION
type fileStatBasicInformation struct {
	FileID                int64
	CreationTime          int64
	LastAccessTime        int64
	LastWriteTime         int64
	ChangeTime            int64
	AllocationSize        int64
	EndOfFile             int64
	FileAttributes        uint32
	ReparseTag            uint32
	NumberOfLinks         uint32
	DeviceType            uint32
	DeviceCharacteristics uint32
	Reserved              uint32
	VolumeSerialNumber    int64
	FileID128             [16]byte
}

// FILE_ALL_INFORMATION with a one-character name, exactly the buffer
// libuv passes (sizeof = 104): the call "fails" with the warning
// STATUS_BUFFER_OVERFLOW whenever the name is longer, which is fine.
type fileAllInformationBuf struct {
	CreationTime         int64
	LastAccessTime       int64
	LastWriteTime        int64
	ChangeTime           int64
	FileAttributes       uint32
	_                    uint32
	AllocationSize       int64
	EndOfFile            int64
	NumberOfLinks        uint32
	DeletePending        byte
	Directory            byte
	_                    [2]byte
	IndexNumber          int64
	EaSize               uint32
	AccessFlags          uint32
	CurrentByteOffset    int64
	Mode                 uint32
	AlignmentRequirement uint32
	FileNameLength       uint32
	FileName             [1]uint16
	_                    [2]byte
}

// FILE_FS_VOLUME_INFORMATION with a one-character label.
type fileFsVolumeInformation struct {
	VolumeCreationTime int64
	VolumeSerialNumber uint32
	VolumeLabelLength  uint32
	SupportsObjects    byte
	_                  byte
	VolumeLabel        [1]uint16
	_                  [4]byte
}

type fileFsDeviceInformation struct {
	DeviceType      uint32
	Characteristics uint32
}

// FILE_ID_FULL_DIR_INFORMATION with a one-character name (sizeof = 88).
type fileIDFullDirInformation struct {
	NextEntryOffset uint32
	FileIndex       uint32
	CreationTime    int64
	LastAccessTime  int64
	LastWriteTime   int64
	ChangeTime      int64
	EndOfFile       int64
	AllocationSize  int64
	FileAttributes  uint32
	FileNameLength  uint32
	EaSize          uint32
	_               uint32
	FileID          int64
	FileName        [1]uint16
	_               [3]uint16
}

func ntError(status uint32) bool   { return status>>30 == 3 }
func ntSuccess(status uint32) bool { return int32(status) >= 0 }

func rtlNtStatusToDosError(status uint32) uint32 {
	r, _, _ := procRtlNtStatusToDosError.Call(uintptr(status))
	return uint32(r)
}

func ntQueryVolumeInformationFile(h syscall.Handle, iosb *ioStatusBlock, buf unsafe.Pointer, size uintptr, class uint32) uint32 {
	r, _, _ := procNtQueryVolumeInformationFile.Call(uintptr(h), uintptr(unsafe.Pointer(iosb)), uintptr(buf), size, uintptr(class))
	return uint32(r)
}

func ntQueryInformationFile(h syscall.Handle, iosb *ioStatusBlock, buf unsafe.Pointer, size uintptr, class uint32) uint32 {
	r, _, _ := procNtQueryInformationFile.Call(uintptr(h), uintptr(unsafe.Pointer(iosb)), uintptr(buf), size, uintptr(class))
	return uint32(r)
}

func ntQueryDirectoryFile(h syscall.Handle, iosb *ioStatusBlock, buf unsafe.Pointer, size uintptr, class uint32, single bool, mask *unicodeString, restart bool) uint32 {
	r, _, _ := procNtQueryDirectoryFile.Call(
		uintptr(h), 0, 0, 0,
		uintptr(unsafe.Pointer(iosb)),
		uintptr(buf), size, uintptr(class),
		boolArg(single), uintptr(unsafe.Pointer(mask)), boolArg(restart),
	)
	return uint32(r)
}

func boolArg(b bool) uintptr {
	if b {
		return 1
	}
	return 0
}

// CodeOf names a Win32 error the way Node does (err.code).
func CodeOf(winerr uint32) string {
	if c, ok := uvCodes[winerr]; ok {
		return c
	}
	return codeUnknown
}

// NamespacedPath mirrors path.win32.toNamespacedPath (Node's C++
// ToNamespacedPath) for an already-resolved absolute path.
func NamespacedPath(p string) string {
	if len(p) <= 2 {
		return p
	}
	if p[0] == '\\' {
		if p[1] == '\\' && p[2] != '?' && p[2] != '.' {
			return `\\?\UNC\` + p[2:]
		}
		return p
	}
	c := p[0]
	if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) && p[1] == ':' && p[2] == '\\' {
		return `\\?\` + p
	}
	return p
}

// toWide converts a path to UTF-16. Node hands libuv WTF-8, which libuv
// converts back; a Go string can't carry lone surrogates, so the
// conversion is the plain UTF-16 one.
func toWide(p string) ([]uint16, bool) {
	w, err := syscall.UTF16FromString(p)
	return w, err == nil
}

// wideLen is wcslen.
func wideLen(w []uint16) int {
	for i, c := range w {
		if c == 0 {
			return i
		}
	}
	return len(w)
}

// statPreparePath is fs__stat_prepare_path: drop one trailing slash
// unless it follows a drive colon.
func statPreparePath(w []uint16) {
	n := wideLen(w)
	if n > 1 && w[n-2] != ':' && (w[n-1] == '\\' || w[n-1] == '/') {
		w[n-1] = 0
	}
}

// filetimeToMs is uv__filetime_to_timespec + Node's Windows
// FillStatsArray (tv_sec is a 32-bit long there, stored through an
// unsigned long) + msFromTimeSpec.
func filetimeToMs(ft int64) float64 {
	ft -= winToUnixTickOffset
	sec := int32(ft / ticksPerSec) // long tv_sec (LLP64: 32-bit)
	nsec := int32((ft % ticksPerSec) * nsecPerTick)
	if nsec < 0 {
		sec--
		nsec += 1e9
	}
	return msFromTimeSpec(float64(uint32(sec)), float64(uint32(nsec)))
}

func assignStat(attrs uint32, endOfFile, lastWrite int64) Stat {
	st := Stat{MtimeMs: filetimeToMs(lastWrite)}
	if attrs&attrDirectory != 0 {
		st.IsDir = true
		st.Size = 0
	} else {
		st.IsFile = true
		st.Size = endOfFile
	}
	return st
}

// nullStat is fs__stat_assign_statbuf_null: a character device, all zero.
func nullStat() Stat { return Stat{} }

type fastResult int

const (
	fastSuccess fastResult = iota
	fastError
	fastTrySlow
)

// statPathFast is fs__stat_path.
func statPathFast(w *uint16) (Stat, uint32, fastResult) {
	if getFileInformationByName == 0 {
		return Stat{}, 0, fastTrySlow
	}
	var info fileStatBasicInformation
	r, _, e := syscall.SyscallN(getFileInformationByName,
		uintptr(unsafe.Pointer(w)), fileStatBasicByNameInfo,
		uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info))
	if r == 0 {
		switch uint32(e) {
		case errorFileNotFound, errorPathNotFound, errorNotReady, errorBadNetName:
			return Stat{}, uint32(e), fastError
		}
		return Stat{}, 0, fastTrySlow
	}
	if info.FileAttributes&attrReparsePoint != 0 {
		return Stat{}, 0, fastTrySlow
	}
	if info.DeviceType == fileDeviceNull {
		return nullStat(), 0, fastSuccess
	}
	return assignStat(info.FileAttributes, info.EndOfFile, info.LastWriteTime), 0, fastSuccess
}

// statHandle is fs__stat_handle (do_lstat = 0).
func statHandle(h syscall.Handle) (Stat, uint32) {
	var iosb ioStatusBlock
	var dev fileFsDeviceInformation
	st := ntQueryVolumeInformationFile(h, &iosb, unsafe.Pointer(&dev), unsafe.Sizeof(dev), classFsDeviceInformation)
	if ntError(st) {
		return Stat{}, rtlNtStatusToDosError(st)
	}
	if dev.DeviceType == fileDeviceNull {
		return nullStat(), 0
	}
	var all fileAllInformationBuf
	iosb = ioStatusBlock{}
	st = ntQueryInformationFile(h, &iosb, unsafe.Pointer(&all), unsafe.Sizeof(all), fileAllInformation)
	if ntError(st) {
		return Stat{}, rtlNtStatusToDosError(st)
	}
	var vol fileFsVolumeInformation
	iosb = ioStatusBlock{}
	st = ntQueryVolumeInformationFile(h, &iosb, unsafe.Pointer(&vol), unsafe.Sizeof(vol), classFsVolumeInformation)
	if iosb.status() != statusNotImplemented && ntError(st) {
		return Stat{}, rtlNtStatusToDosError(st)
	}
	return assignStat(all.FileAttributes, all.EndOfFile, all.LastWriteTime), 0
}

// statDirectory is fs__stat_directory (do_lstat = 0): stat a file that
// can't be opened (access denied / sharing violation) from its parent
// directory's listing.
func statDirectory(w []uint16, retErr uint32) (Stat, uint32) {
	n := wideLen(w)
	split := n
	includesName := false
	for split > 0 && w[split-1] != '\\' && w[split-1] != '/' && w[split-1] != ':' {
		if w[split-1] != '.' {
			includesName = true
		}
		split--
	}
	var dirPath []uint16
	restore := -1
	switch {
	case split == 0 && includesName:
		dirPath = []uint16{'.', 0}
	case split > 0 && (w[split-1] == '\\' || w[split-1] == '/'):
		dirPath = w
		if !includesName {
			split = n
		} else {
			restore = split - 1
		}
	default:
		dirPath = w
		split = n
	}
	fileName := w[split:n]
	if restore >= 0 {
		// Terminate the directory part in a copy (libuv writes a NUL in
		// place and puts the separator back afterwards).
		dirPath = append(append([]uint16(nil), w[:restore]...), 0)
	}
	for _, c := range fileName {
		if c == '*' || c == '?' || c == '>' || c == '<' || c == '"' {
			return Stat{}, errorInvalidName
		}
	}

	h, err := syscall.CreateFile(&dirPath[0], fileListDirectory, shareAll, nil,
		syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return Stat{}, errnoOf(err)
	}
	defer syscall.CloseHandle(h)

	if len(fileName) > 0x7FFF {
		return Stat{}, rtlNtStatusToDosError(statusInvalidParameter)
	}
	var mask unicodeString
	mask.Length = uint16(len(fileName) * 2)
	mask.MaximumLength = mask.Length
	if len(fileName) > 0 {
		mask.Buffer = &fileName[0]
	} else {
		empty := []uint16{0}
		mask.Buffer = &empty[0]
	}

	var iosb ioStatusBlock
	var info fileIDFullDirInformation
	st := ntQueryDirectoryFile(h, &iosb, unsafe.Pointer(&info), unsafe.Sizeof(info),
		fileIDFullDirectoryInformation, true, &mask, true)
	if !ntSuccess(st) && st != statusBufferOverflow {
		if st == statusNoMoreFiles {
			return Stat{}, errorPathNotFound
		}
		return Stat{}, rtlNtStatusToDosError(st)
	}
	if info.FileAttributes&attrReparsePoint != 0 {
		// A link we could not open: stat gives up with the original error.
		return Stat{}, retErr
	}
	var vol fileFsVolumeInformation
	iosb = ioStatusBlock{}
	st = ntQueryVolumeInformationFile(h, &iosb, unsafe.Pointer(&vol), unsafe.Sizeof(vol), classFsVolumeInformation)
	if iosb.status() != statusNotImplemented && ntError(st) {
		return Stat{}, rtlNtStatusToDosError(st)
	}
	var dev fileFsDeviceInformation
	iosb = ioStatusBlock{}
	st = ntQueryVolumeInformationFile(h, &iosb, unsafe.Pointer(&dev), unsafe.Sizeof(dev), classFsDeviceInformation)
	if ntError(st) {
		return Stat{}, rtlNtStatusToDosError(st)
	}
	return assignStat(info.FileAttributes, info.EndOfFile, info.LastWriteTime), 0
}

func errnoOf(err error) uint32 {
	if e, ok := err.(syscall.Errno); ok {
		return uint32(e)
	}
	return 0xFFFFFFFF
}

// uvStat is fs__stat: stat(path) following links. It returns the stat or
// the Win32 error, and whether the named object itself may be a reparse
// point (link / junction), which the caller must resolve for
// containment.
func uvStat(path string) (Stat, uint32, bool) {
	w, ok := toWide(NamespacedPath(path))
	if !ok {
		// A NUL byte; the caller rejects those before getting here.
		return Stat{}, errorInvalidName, false
	}
	statPreparePath(w)

	st, e, r := statPathFast(&w[0])
	switch r {
	case fastSuccess:
		return st, 0, false
	case fastError:
		return Stat{}, e, false
	}

	h, err := syscall.CreateFile(&w[0], fileReadAttributes, shareAll, nil,
		syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		code := errnoOf(err)
		if code != errorAccessDenied && code != errorSharingViolation {
			return Stat{}, code, false
		}
		st, e := statDirectory(w, code)
		// statDirectory never follows a link: success means the entry is
		// not a reparse point.
		return st, e, false
	}
	st, e = statHandle(h)
	syscall.CloseHandle(h)
	if e != 0 {
		return Stat{}, e, false
	}
	return st, 0, mayBeLink(&w[0])
}

// mayBeLink reports whether the object at w itself (not its target) is a
// reparse point, or couldn't be checked.
func mayBeLink(w *uint16) bool {
	a, err := syscall.GetFileAttributes(w)
	return err != nil || a&attrReparsePoint != 0
}

// StatPath stats path (absolute, cleaned) like fs.stat. code is "" on
// success, else Node's err.code. link reports that the final component
// may be a link whose target the caller has to check.
func StatPath(path string) (st Stat, code string, link bool) {
	st, e, link := uvStat(path)
	if e != 0 {
		return Stat{}, CodeOf(e), false
	}
	return st, "", link
}

// ReadDir lists dir like fs.readdir(dir, { withFileTypes: true }):
// fs__scandir, entries in the order the file system returns them.
func ReadDir(dir string) ([]Dirent, string) {
	w, ok := toWide(NamespacedPath(dir))
	if !ok {
		return nil, CodeOf(errorInvalidName)
	}
	h, err := syscall.CreateFile(&w[0], fileListDirectory|synchronize, shareAll, nil,
		syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return nil, CodeOf(errnoOf(err))
	}
	defer syscall.CloseHandle(h)

	// 8 KiB, 8-byte aligned, like libuv's stack buffer.
	buf := make([]uint64, 1024)
	bp := unsafe.Pointer(&buf[0])
	size := uintptr(len(buf) * 8)
	var iosb ioStatusBlock
	st := ntQueryDirectoryFile(h, &iosb, bp, size, fileDirectoryInformation, false, nil, true)
	if st == statusInvalidParameter {
		return nil, "ENOTDIR"
	}
	var out []Dirent
	raw := unsafe.Slice((*byte)(bp), size)
	for ntSuccess(st) {
		off := uint32(0)
		for {
			// FILE_DIRECTORY_INFORMATION: NextEntryOffset @0,
			// FileAttributes @56, FileNameLength @60, FileName @64.
			next := *(*uint32)(unsafe.Pointer(&raw[off]))
			attrs := *(*uint32)(unsafe.Pointer(&raw[off+56]))
			nameLen := *(*uint32)(unsafe.Pointer(&raw[off+60])) / 2
			name := unsafe.Slice((*uint16)(unsafe.Pointer(&raw[off+64])), nameLen)
			for len(name) > 0 && name[len(name)-1] == 0 {
				name = name[:len(name)-1]
			}
			skip := len(name) == 0 ||
				(len(name) == 1 && name[0] == '.') ||
				(len(name) == 2 && name[0] == '.' && name[1] == '.')
			if !skip {
				kind := KindFile
				switch {
				case attrs&attrDevice != 0:
					kind = KindChar
				case attrs&attrReparsePoint != 0:
					kind = KindLink
				case attrs&attrDirectory != 0:
					kind = KindDir
				}
				out = append(out, Dirent{Name: wideToNodeString(name), Kind: kind})
			}
			if next == 0 {
				break
			}
			off += next
		}
		iosb = ioStatusBlock{}
		st = ntQueryDirectoryFile(h, &iosb, bp, size, fileDirectoryInformation, false, nil, false)
		if st == statusSuccess && iosb.Information == 0 {
			st = statusBufferOverflow
		}
	}
	if st != statusNoMoreFiles {
		return nil, CodeOf(rtlNtStatusToDosError(st))
	}
	return out, ""
}

// wideToNodeString converts a UTF-16 name the way Node ends up seeing it:
// libuv encodes WTF-8, V8 decodes UTF-8, so a lone surrogate (3 WTF-8
// bytes) becomes three U+FFFD.
func wideToNodeString(u []uint16) string {
	var sb strings.Builder
	sb.Grow(len(u))
	for i := 0; i < len(u); i++ {
		c := rune(u[i])
		switch {
		case c >= 0xD800 && c <= 0xDBFF && i+1 < len(u) && u[i+1] >= 0xDC00 && u[i+1] <= 0xDFFF:
			sb.WriteRune(((c - 0xD800) << 10) + (rune(u[i+1]) - 0xDC00) + 0x10000)
			i++
		case c >= 0xD800 && c <= 0xDFFF:
			sb.WriteString("���")
		default:
			sb.WriteRune(c)
		}
	}
	return sb.String()
}
