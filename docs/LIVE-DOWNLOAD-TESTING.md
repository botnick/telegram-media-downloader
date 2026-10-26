# Live large-file acceptance testing

The normal Go test suite does not contact Telegram. An operator can explicitly
run `TestLargeMediaLiveAcceptance` with their own account and existing media.
The test fetches fresh message references, downloads each file through the
production `DownloadMedia` method, flushes it to disk, then reads it back and
compares its size and SHA-256 with the original. It does not change messages,
monitoring configuration, or the production media catalog.

Create a private directory on disk (not a RAM-backed `/tmp`) outside tracked
source files, mode `0700`, containing these mode `0600` files:

- `session.enc`: a separately authorized native encrypted test session.
- `secret.key`: the encryption secret for that test session.
- `config.json`: API credentials and a manifest in the following shape:

```json
{
  "AppID": 12345,
  "AppHash": "YOUR_API_HASH",
  "Files": [
    {
      "ID": 1,
      "Channel": 1234567890,
      "AccessHash": 123456789,
      "Message": 42,
      "Size": 392023128,
      "SHA256": "64_HEXADECIMAL_CHARACTERS_COMPUTED_FROM_THE_ORIGINAL_FILE"
    }
  ]
}
```

IDs, access hashes, sizes and digests must come from the operator's actual
account/catalog; the example values are placeholders. Each source file must be
at least 256 MiB. Keep all credentials and manifests out of Git and public logs.
Use a separate Telegram authorization for the test machine; do not run one
copied session key simultaneously on machines with different public IPs.

From `core-service`, with sufficient disk space for the largest file:

```sh
TGDL_LIVE_DOWNLOAD_DIR=/absolute/private/test-directory \
TGDL_LIVE_DOWNLOAD_THREADS=4 \
go test -v -count=1 -timeout=45m ./internal/telegram \
  -run '^TestLargeMediaLiveAcceptance$'
```

Set `TGDL_LIVE_DOWNLOAD_THREADS=1` for a sequential baseline (allowed range
1–16). Run measurements serially so sessions and bandwidth do not compete.
The test stops after the first failed file and cleans up only its own temporary
download directories. It leaves the supplied manifest and test authorization
in place for the operator to retain securely or revoke after testing.

Compare the same file on the same machine. Report bytes, elapsed time and
hash verification, and distinguish local network/cache effects from a general
speed guarantee. Contract tests for the optional AI sidecars do not measure
real model accuracy or GPU performance.
