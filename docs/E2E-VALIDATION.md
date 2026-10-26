# End-to-end validation

The native executable is tested with real HTTP connections, isolated SQLite databases and independent clients. Run instructions are in `tests/e2e/README.md`. CI runs these checks alongside Go race tests and UI fixture tests.

| Suite | End-to-end behavior checked |
| --- | --- |
| Web sessions | Login, multiple WebSockets, logout, guest disable, password rotation, expiry, shutdown, persisted sessions |
| HTTP policy | gzip/deflate/Brotli byte equality, HTTPS policy, trusted proxy handling, CSP, rate limits, secure cookies |
| Backup CLI | Independent AES-GCM fixture decryption, database restore/integrity, tampering and overwrite rejection |
| Ambient rescue | Independent WebSocket transport, authentication and recovery behavior |
| Cluster | Two servers, 502-row paging, signed WebSocket events, replay/forgery rejection, offline edits/deletes, restart and restore reconciliation, revocation |
| FTP/FTPS | Independent server, plaintext and TLS uploads, encrypted mirrors, same-size edits, snapshot restore, no unexpected retries or staging leftovers |
| Media | Actual video fixture, catalog/search, byte ranges, ZIP contents, signed sharing/revocation, FFmpeg seekbar generation and retrieval, guest write denial |
| Browser | Real login and APIs, 16 routes at 390px and 1280px, visible content, overflow and uncaught JavaScript checks; no API mocks |

## Additional owner-authorized live checks, 2026-10-26

An independently authorized Telegram session on the test machine downloaded three existing files (392,023,128; 579,399,644; and 289,598,805 bytes). All matched original SHA-256 after disk readback. The real application subsequently accepted a message URL, paused/resumed its queue, downloaded the 289,598,805-byte file and matched its original SHA-256. Account browsing returned 150 dialogs through the actual server. Credentials and private logs remain outside Git.

Existing production face-detection and NSFW services accepted a generated 320×240 image and returned model results. This verifies inference request handling, not recognition accuracy or positive face embeddings. The preceding release also passed a live temporary Telegram forum/topic forwarding test with cleanup.

## Coverage limits

These checks are explicit scenarios, not every possible action or device. Browser navigation checks do not prove every settings control or dialog. No claim is made for credentialed S3/SFTP/WebDAV/Google Drive/Dropbox flows, GPU acceleration, all operating systems at runtime, positive face clustering, every Telegram media type, or disaster recovery on the production database. Cross-compilation and unit tests are separate evidence and must not be described as live E2E coverage. Provider-specific live testing needs a configured isolated test destination.
