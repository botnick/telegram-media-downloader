# Native end-to-end checks

Build the actual server with `make build`, then install Python test dependencies:

```sh
python -m pip install cryptography pyOpenSSL pyftpdlib==2.2.0 websocket-client
python tests/e2e/ws_sessions.py
python tests/e2e/http_policy.py
python tests/e2e/tgdb_cli.py
python tests/e2e/ambient_rescue.py
python tests/e2e/cluster_live_process.py
python tests/e2e/ftp_interop.py
python tests/e2e/media.py
python -m pip install playwright
python -m playwright install chromium
python tests/e2e/browser.py
```

`TGDL_E2E_BINARY` selects a different executable. Each script starts real processes and isolated databases with generated fixtures under `tmp/e2e`, then stops its processes and removes fixture data. No production credentials are required. Run sequentially. Media checks need FFmpeg. Browser checks use the running native server with no mocked API responses; optional external fonts/icons are blocked so CDN outages cannot stall navigation. Chromium must be installed. FTP uses an independent pyftpdlib server, explicit TLS, encrypted mirror downloads, same-size edits and snapshot restore; unexpected retries fail the test. Cluster checks use two processes and independent WebSocket/HMAC clients.

These tests complement unit/race tests and UI fixtures; they do not claim cloud-provider credentials, GPU inference, or live Telegram coverage. For real Telegram downloads see `docs/LIVE-DOWNLOAD-TESTING.md`. Never check account keys, private media or production data into the repository.
