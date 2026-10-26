from pathlib import Path
import base64, hashlib, http.client, json, os, secrets, socket, sqlite3, struct, subprocess, tempfile, time

room=Path(__file__).resolve().parents[2]
scratch=room/"tmp/e2e";scratch.mkdir(parents=True,exist_ok=True)
binary=Path(os.environ.get("TGDL_E2E_BINARY",str(room/"core-service/tgdl-server"))).resolve()
with tempfile.TemporaryDirectory(prefix='ambient-rescue-', dir=scratch) as tmp:
    root = Path(tmp)
    data = root / 'data'
    data.mkdir()
    reserve = socket.socket()
    reserve.bind(('127.0.0.1', 0))
    port = reserve.getsockname()[1]
    reserve.close()
    log = open(root / 'server.log', 'wb')
    process = None
    sockets = []

    def request(path, body=None, token=None):
        c = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Cookie'] = 'tg_dl_session=' + token
        c.request('GET' if body is None else 'POST', path, body=None if body is None else json.dumps(body), headers=headers)
        r = c.getresponse()
        raw, status, cookie = r.read(), r.status, r.getheader('Set-Cookie')
        c.close()
        content = raw if path.startswith('/files/') else json.loads(raw)
        return status, content, None if cookie is None else cookie.split(';', 1)[0].split('=', 1)[1]

    def start():
        global process
        env = dict(os.environ, TGDL_DATA_DIR=str(data), PORT=str(port), TGDL_SECURE_COOKIES='0', TRUST_PROXY='loopback')
        process = subprocess.Popen([str(binary)], env=env, stdout=log, stderr=log)
        for _ in range(100):
            assert process.poll() is None, 'startup failed'
            try:
                if request('/api/version')[0] == 200:
                    return
            except OSError:
                pass
            time.sleep(.05)
        raise AssertionError('startup timeout')

    def stop():
        global process
        if process:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise
            assert process.returncode == 0, process.returncode
            process = None

    def ws(token):
        s = socket.create_connection(('127.0.0.1', port), timeout=5)
        sockets.append(s)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        s.sendall((f'GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\nCookie: tg_dl_session={token}\r\n\r\n').encode())
        header = b''
        while not header.endswith(b'\r\n\r\n'):
            b = s.recv(1)
            assert b, 'handshake ended'
            header += b
        assert header.startswith(b'HTTP/1.1 101'), header
        expected = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
        assert expected in header, 'incorrect WebSocket accept'
        return s

    def exact(s, n):
        result = b''
        while len(result) < n:
            part = s.recv(n - len(result))
            assert part, 'unexpected EOF'
            result += part
        return result

    def event(s):
        first, second = exact(s, 2)
        assert first & 128 and not second & 128, (first, second)
        length = second & 127
        if length == 126:
            length = struct.unpack('!H', exact(s, 2))[0]
        elif length == 127:
            length = struct.unpack('!Q', exact(s, 8))[0]
        payload = exact(s, length)
        if first & 15 == 9:
            mask = secrets.token_bytes(4)
            s.sendall(bytes([138, 128 | len(payload)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
            return event(s)
        assert first & 15 == 1, first
        return json.loads(payload)

    try:
        start()
        status, _, admin = request('/api/auth/setup', {'password': 'fixture-admin-password'})
        assert status == 200
        stop()
        downloads = data / 'downloads'
        downloads.mkdir(exist_ok=True)
        (downloads / 'shared.bin').write_bytes(b'live')
        (downloads / 'expired.bin').write_bytes(b'gone')
        with sqlite3.connect(data / 'db.sqlite') as db:
            db.executemany('INSERT INTO downloads(id,group_id,message_id,file_path,file_size,pending_until) VALUES(?,?,?,?,?,?)', [
                (10, '-1000000000042', 10, 'shared.bin', 4, 1),
                (11, '-1000000000042', 11, 'shared.bin', 4, None),
                (12, '-1000000000042', 12, 'expired.bin', 4, 1),
            ])
            # More than one batch proves the actual timer drains the remainder
            # after one second instead of postponing it for ten minutes.
            db.executemany('INSERT INTO downloads(group_id,message_id,pending_until) VALUES(?,?,1)', [('backlog', i) for i in range(501)])
        start()
        s = ws(admin)
        seen, cleared, deleted = set(), [], set()
        deadline = time.monotonic() + 38
        while time.monotonic() < deadline and not {'monitor_status_push', 'stats_push'}.issubset(seen):
            e = event(s)
            kind = e['type']
            seen.add(kind)
            if kind == 'monitor_status_push':
                status, current, _ = request('/api/monitor/status', token=admin)
                assert status == 200 and e['payload'] == current, (e, current)
            elif kind == 'rescue_sweep_done':
                cleared.append(e['count'])
                assert len(deleted) == sum(cleared), (len(deleted), cleared)
            elif kind == 'file_deleted':
                deleted.add(e['id'])
            elif kind == 'stats_push':
                assert e['payload']['totalFiles'] == 1 and e['payload']['totalSize'] == 4, e
        assert {'monitor_status_push', 'stats_push'}.issubset(seen), seen
        assert cleared == [500, 3], cleared
        assert len(deleted) == 503, len(deleted)
        status, stats, _ = request('/api/rescue/stats', token=admin)
        assert status == 200 and stats == {'lastSweepCleared': 3, 'pending': 0, 'rescued': 0}, stats
        assert request('/files/shared.bin', token=admin)[:2] == (200, b'live')
        assert not (downloads / 'expired.bin').exists()
        with sqlite3.connect(data / 'db.sqlite') as db:
            assert db.execute('SELECT id FROM downloads').fetchall() == [(11,)]
            assert db.execute('SELECT count(*) FROM tgdl_file_cleanup').fetchone()[0] == 0
        stop()
        while s.recv(4096):
            pass  # Drain frames already written before shutdown, then EOF.
        start()
        assert request('/api/rescue/stats', token=admin)[1]['lastSweepCleared'] == 3
        stop()
        print('PASS: native executable, raw RFC6455, real 3s/30s status timers, 503 expired rows drained in 500+3 batches, shared asset preserved, unique asset deleted, no cleanup debt, counters persist across restart, SIGTERM exits0 and closes socket')
    finally:
        stop()
        for s in sockets:
            s.close()
        log.close()
