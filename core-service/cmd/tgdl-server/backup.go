package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/botnick/telegram-media-downloader/core-service/internal/backup"
)

func backupDecrypt(args []string, stdout, stderr io.Writer) int {
	return backupRecovery(args, stdout, stderr, false)
}

func backupRestore(args []string, stdout, stderr io.Writer) int {
	return backupRecovery(args, stdout, stderr, true)
}

func backupRecovery(args []string, stdout, stderr io.Writer, restore bool) int {
	command, outputHelp := "backup-decrypt", "new plaintext output file (must not exist)"
	if restore {
		command, outputHelp = "backup-restore", "new inactive data directory (must not exist)"
	}
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(stderr)
	input := flags.String("input", "", "TGDB v1 backup file")
	output := flags.String("output", "", outputHelp)
	password := flags.String("passphrase-file", "", "file containing the exact passphrase bytes; no trimming")
	saltHex := flags.String("salt-hex", "", "destination PBKDF2 salt in hexadecimal")
	infoFile := flags.String("recovery-info", "", "saved recovery JSON from the administrator API")
	var plaintext bool
	var maxBytes int64
	var maxFiles int
	if restore {
		flags.BoolVar(&plaintext, "plaintext", false, "explicitly restore an unencrypted tar.gz snapshot")
		flags.Int64Var(&maxBytes, "max-bytes", 16<<30, "maximum extracted bytes")
		flags.IntVar(&maxFiles, "max-files", 100000, "maximum archive entries")
	}
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	invalidCrypto := *password == "" || (*saltHex == "") == (*infoFile == "")
	if plaintext {
		invalidCrypto = *password != "" || *saltHex != "" || *infoFile != ""
	}
	if flags.NArg() != 0 || *input == "" || *output == "" || invalidCrypto {
		fmt.Fprintf(stderr, "usage: tgdl-server %s --input FILE --output NEW_PATH --passphrase-file FILE (--salt-hex HEX | --recovery-info JSON)\n", command)
		if restore {
			fmt.Fprintln(stderr, "For an unencrypted snapshot use --plaintext without passphrase or salt flags.")
		}
		return 2
	}
	if *infoFile != "" {
		data, err := readBackupMaterial(*infoFile)
		if err != nil {
			fmt.Fprintln(stderr, "read recovery info:", err)
			return 2
		}
		var info backup.RecoveryInfo
		var wrapper struct {
			Recovery backup.RecoveryInfo `json:"recovery"`
		}
		if json.Unmarshal(data, &wrapper) == nil && wrapper.Recovery.Format != "" {
			info = wrapper.Recovery
		} else if err = json.Unmarshal(data, &info); err != nil {
			fmt.Fprintln(stderr, "invalid recovery JSON")
			return 2
		}
		if info.Format != "TGDB" || info.Version != 1 || info.KDF != "PBKDF2-HMAC-SHA256" || info.Iterations != 200000 {
			fmt.Fprintln(stderr, "unsupported recovery parameters")
			return 2
		}
		*saltHex = info.SaltHex
	}
	var salt, pass []byte
	var err error
	if !plaintext {
		salt, err = hex.DecodeString(*saltHex)
		if err != nil || len(salt) < 8 || len(salt) > 1024 {
			fmt.Fprintln(stderr, "invalid backup salt")
			return 2
		}
		pass, err = readBackupMaterial(*password)
		if err != nil {
			fmt.Fprintln(stderr, "read passphrase file:", err)
			return 2
		}
		defer clear(pass)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if restore {
		result, err := backup.RestoreSnapshot(ctx, *input, *output, backup.RestoreOptions{Passphrase: string(pass), Salt: salt, Plaintext: plaintext, MaxBytes: maxBytes, MaxFiles: maxFiles})
		if err != nil {
			fmt.Fprintln(stderr, "backup restore failed:", err)
			return 1
		}
		fmt.Fprintf(stdout, "Snapshot validated and restored: %d files, %d bytes.\n", result.Files, result.Bytes)
		return 0
	}
	if err = backup.DecryptFile(ctx, *input, *output, string(pass), salt); err != nil {
		fmt.Fprintln(stderr, "backup decryption failed:", err)
		return 1
	}
	fmt.Fprintln(stdout, "Backup authenticated and decrypted.")
	return 0
}

func readBackupMaterial(name string) ([]byte, error) {
	f, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || st.Size() > 1<<20 {
		return nil, errors.New("backup material must be a regular file up to 1 MiB")
	}
	b, err := io.ReadAll(io.LimitReader(f, 1<<20+1))
	if len(b) > 1<<20 {
		clear(b)
		return nil, errors.New("backup material exceeds 1 MiB")
	}
	return b, err
}
