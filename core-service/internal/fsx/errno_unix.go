//go:build !windows

package fsx

import "syscall"

// uvErrnoNames is libuv's UV_ERRNO_MAP (include/uv.h, v1.51) for the
// errnos every Unix target defines; errno_<os>.go adds the OS-specific
// ones. Node sets err.code from this map and uses "UNKNOWN" for anything
// else (ESTALE on an NFS mount, for instance).
var uvErrnoNames = map[syscall.Errno]string{
	syscall.E2BIG:           "E2BIG",
	syscall.EACCES:          "EACCES",
	syscall.EADDRINUSE:      "EADDRINUSE",
	syscall.EADDRNOTAVAIL:   "EADDRNOTAVAIL",
	syscall.EAFNOSUPPORT:    "EAFNOSUPPORT",
	syscall.EAGAIN:          "EAGAIN",
	syscall.EALREADY:        "EALREADY",
	syscall.EBADF:           "EBADF",
	syscall.EBUSY:           "EBUSY",
	syscall.ECANCELED:       "ECANCELED",
	syscall.ECONNABORTED:    "ECONNABORTED",
	syscall.ECONNREFUSED:    "ECONNREFUSED",
	syscall.ECONNRESET:      "ECONNRESET",
	syscall.EDESTADDRREQ:    "EDESTADDRREQ",
	syscall.EEXIST:          "EEXIST",
	syscall.EFAULT:          "EFAULT",
	syscall.EFBIG:           "EFBIG",
	syscall.EHOSTUNREACH:    "EHOSTUNREACH",
	syscall.EINTR:           "EINTR",
	syscall.EINVAL:          "EINVAL",
	syscall.EIO:             "EIO",
	syscall.EISCONN:         "EISCONN",
	syscall.EISDIR:          "EISDIR",
	syscall.ELOOP:           "ELOOP",
	syscall.EMFILE:          "EMFILE",
	syscall.EMSGSIZE:        "EMSGSIZE",
	syscall.ENAMETOOLONG:    "ENAMETOOLONG",
	syscall.ENETDOWN:        "ENETDOWN",
	syscall.ENETUNREACH:     "ENETUNREACH",
	syscall.ENFILE:          "ENFILE",
	syscall.ENOBUFS:         "ENOBUFS",
	syscall.ENODEV:          "ENODEV",
	syscall.ENOENT:          "ENOENT",
	syscall.ENOMEM:          "ENOMEM",
	syscall.ENOPROTOOPT:     "ENOPROTOOPT",
	syscall.ENOSPC:          "ENOSPC",
	syscall.ENOSYS:          "ENOSYS",
	syscall.ENOTCONN:        "ENOTCONN",
	syscall.ENOTDIR:         "ENOTDIR",
	syscall.ENOTEMPTY:       "ENOTEMPTY",
	syscall.ENOTSOCK:        "ENOTSOCK",
	syscall.ENOTSUP:         "ENOTSUP",
	syscall.EOVERFLOW:       "EOVERFLOW",
	syscall.EPERM:           "EPERM",
	syscall.EPIPE:           "EPIPE",
	syscall.EPROTO:          "EPROTO",
	syscall.EPROTONOSUPPORT: "EPROTONOSUPPORT",
	syscall.EPROTOTYPE:      "EPROTOTYPE",
	syscall.ERANGE:          "ERANGE",
	syscall.EROFS:           "EROFS",
	syscall.ESHUTDOWN:       "ESHUTDOWN",
	syscall.ESPIPE:          "ESPIPE",
	syscall.ESRCH:           "ESRCH",
	syscall.ETIMEDOUT:       "ETIMEDOUT",
	syscall.ETXTBSY:         "ETXTBSY",
	syscall.EXDEV:           "EXDEV",
	syscall.ENXIO:           "ENXIO",
	syscall.EMLINK:          "EMLINK",
	syscall.EHOSTDOWN:       "EHOSTDOWN",
	syscall.ENOTTY:          "ENOTTY",
	syscall.EILSEQ:          "EILSEQ",
	syscall.ESOCKTNOSUPPORT: "ESOCKTNOSUPPORT",
	syscall.ENOEXEC:         "ENOEXEC",
}

func init() {
	for k, v := range osErrnoNames {
		uvErrnoNames[k] = v
	}
}
