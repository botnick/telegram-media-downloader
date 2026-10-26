from pathlib import Path
import hashlib, hmac, http.client, json, os, socket, sqlite3, subprocess, tempfile, time
from urllib.parse import quote

room=Path(__file__).resolve().parents[2]
scratch=room/"tmp/e2e";scratch.mkdir(parents=True,exist_ok=True)
binary=Path(os.environ.get("TGDL_E2E_BINARY",str(room/"core-service/tgdl-server"))).resolve()

class Node:
    def __init__(self, root):
        self.data = root
        self.data.mkdir()
        with socket.socket() as reserve:
            reserve.bind(('127.0.0.1', 0))
            self.port = reserve.getsockname()[1]
        self.url = f'http://127.0.0.1:{self.port}'
        self.log = open(root / 'server.log', 'wb')
        self.process = None
        self.token = None

    def request(self, path, method='GET', body=None, headers=None, admin=True):
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        merged = dict(headers or {})
        if admin and self.token:
            merged['Cookie'] = 'tg_dl_session=' + self.token
        if body is not None:
            merged['Content-Type'] = 'application/json'
            body = json.dumps(body).encode()
        c.request(method, path, body=body, headers=merged)
        r = c.getresponse()
        status, raw, received = r.status, r.read(), dict(r.getheaders())
        c.close()
        result = json.loads(raw) if received.get('Content-Type', '').startswith('application/json') else raw
        return status, result, received

    def start(self):
        env = dict(os.environ, TGDL_DATA_DIR=str(self.data), PORT=str(self.port), PUBLIC_URL=self.url,
                   TGDL_SECURE_COOKIES='0', TRUST_PROXY='loopback')
        self.process = subprocess.Popen([str(binary)], env=env, stdout=self.log, stderr=self.log)
        for _ in range(100):
            assert self.process.poll() is None, 'server exited during boot'
            try:
                if self.request('/api/version')[0] == 200:
                    return
            except OSError:
                pass
            time.sleep(.05)
        raise AssertionError('server boot timeout')

    def setup(self):
        status, _, headers = self.request('/api/auth/setup', 'POST', {'password':'fixture-admin-password'})
        assert status == 200
        self.token = headers['Set-Cookie'].split(';',1)[0].split('=',1)[1]

    def stop(self):
        p, self.process = self.process, None
        if p is not None:
            p.terminate()
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait()
                raise
            assert p.returncode == 0, p.returncode

    def identity(self):
        status, body, _ = self.request('/api/cluster/identity')
        assert status == 200
        return body['peerId']

def signed(peer, key, target, stamp):
    payload = f'GET\n{target}\n{stamp}\n{hashlib.sha256(b"").hexdigest()}'.encode()
    return {'X-Peer-Id':peer, 'X-Peer-Ts':str(stamp),
            'X-Peer-Signature':hmac.new(key, payload, hashlib.sha256).hexdigest()}


import tarfile, websocket
binary=Path(os.environ.get("TGDL_E2E_BINARY",str(room/"core-service/tgdl-server"))).resolve()
def cache(node,peer):
    with sqlite3.connect(node.data/'db.sqlite') as db:
        return dict(db.execute('SELECT remote_id,file_name FROM peer_downloads WHERE peer_id=?',(peer,)))
def converge(node,peer,predicate,what,timeout=15):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        value=cache(node,peer)
        if predicate(value): return value
        time.sleep(.05)
    raise AssertionError(what)
def peer_ws(node,peer,key):
    ts=int(time.time()*1000)+7
    sig=hmac.new(key,f'connect|{ts}'.encode(),hashlib.sha256).hexdigest()
    return websocket.create_connection(node.url.replace('http','ws')+f'/ws/cluster?peer={peer}&ts={ts}&sig={sig}',timeout=5)
with tempfile.TemporaryDirectory(prefix='cluster-live-process-',dir=scratch) as tmp:
    root=Path(tmp);a,b=Node(root/'a'),Node(root/'b')
    try:
        a.start();a.setup();b.start();b.setup();aid,bid=a.identity(),b.identity()
        with sqlite3.connect(b.data/'db.sqlite') as db:
            db.executemany('INSERT INTO downloads(id,group_id,message_id,file_path,file_name) VALUES(?,?,?,?,?)',[(i,'fixture',i,f'{i}.bin',f'{i}.bin') for i in range(1,503)])
        code=b.request('/api/cluster/identity/pairing-code','POST',{})[1]['code']
        assert a.request('/api/cluster/peers','POST',{'url':b.url,'pairingCode':code})[0]==200
        converge(a,bid,lambda rows:len(rows)==502,'initial automatic paged sync')
        with sqlite3.connect(a.data/'db.sqlite') as db:
            key=db.execute('SELECT shared_secret FROM peers WHERE peer_id=?',(bid,)).fetchone()[0]
        # Independent client verifies server's released event HMAC.
        c=peer_ws(b,aid,key)
        msg=json.loads(c.recv());assert msg['type']=='catalog_changed'
        digest=hashlib.sha256(json.dumps(msg['payload'],ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
        assert hmac.compare_digest(msg['sig'],hmac.new(key,f"{msg['type']}|{msg['ts']}|{digest}".encode(),hashlib.sha256).hexdigest())
        c.send(json.dumps({'type':'download_added','payload':{'id':9001,'file_path':'forged.bin'},'ts':int(time.time()*1000),'sig':'00'*32}))
        try:
            while c.recv(): pass
        except websocket.WebSocketConnectionClosedException: pass
        c.close();assert 9001 not in cache(b,aid)
        # Preserve an earlier real database as an unencrypted native snapshot.
        snapshot_db=root/'snapshot.sqlite'
        with sqlite3.connect(b.data/'db.sqlite') as src,sqlite3.connect(snapshot_db) as dst: src.backup(dst)
        archive=root/'snapshot.tar.gz'
        with tarfile.open(archive,'w:gz') as tar:
            tar.add(snapshot_db,arcname='db.sqlite')
            if (b.data/'config.json').exists(): tar.add(b.data/'config.json',arcname='config.json')
        oldstate=a.request('/api/cluster/sync/state')[1][bid]
        b.stop()
        with sqlite3.connect(b.data/'db.sqlite') as db:
            db.execute("UPDATE downloads SET file_name='renamed ไทย %+.bin' WHERE id=42")
            db.execute('DELETE FROM downloads WHERE id=43')
            db.execute("INSERT INTO downloads(id,group_id,message_id,file_path,file_name) VALUES(503,'fixture',503,'new.bin','new.bin')")
        b.start()
        converge(a,bid,lambda rows:len(rows)==502 and 43 not in rows and rows.get(42)=='renamed ไทย %+.bin' and rows.get(503)=='new.bin','offline old-row edits/deletes missed')
        a.stop();a.start()
        assert a.identity()==aid
        assert a.request('/api/cluster/sync/state')[1][bid]['catalogEpoch']==oldstate['catalogEpoch']
        # Restore the earlier DB, then make its revision exceed the receiver's
        # cursor. Only epoch rotation can distinguish the divergent histories.
        b.stop();restored=root/'restored'
        result=subprocess.run([str(binary),'backup-restore','--plaintext','--input',str(archive),'--output',str(restored)],capture_output=True,timeout=15)
        assert result.returncode==0,result.stderr.decode()
        with sqlite3.connect(restored/'db.sqlite') as db:
            for i in range(10): db.execute('UPDATE downloads SET file_name=? WHERE id=1',(f'restored-{i}',))
            newepoch=json.loads(db.execute("SELECT value FROM kv WHERE key='cluster_catalog_epoch'").fetchone()[0])
            assert newepoch!=oldstate['catalogEpoch']
        b.data=restored;b.start()
        converge(a,bid,lambda rows:len(rows)==502 and rows.get(42)=='42.bin' and 43 in rows and 503 not in rows and rows.get(1)=='restored-9','restored epoch did not replace divergent cache')
        # Keep a live socket beyond the ordinary HTTP request deadline.
        c=peer_ws(b,aid,key);c.recv();time.sleep(11)
        ts=int(time.time()*1000)
        digest=hashlib.sha256(b'{}').hexdigest();sig=hmac.new(key,f'ping|{ts}|{digest}'.encode(),hashlib.sha256).hexdigest()
        c.send(json.dumps({'type':'ping','payload':{},'ts':ts,'sig':sig}))
        time.sleep(.1)
        with sqlite3.connect(b.data/'db.sqlite') as db: assert db.execute('SELECT ws_last_seen FROM peers WHERE peer_id=?',(aid,)).fetchone()[0]>=ts
        assert b.request('/api/cluster/peers/'+aid,'DELETE')[0]==200
        c.settimeout(3)
        try:
            while c.recv(): pass
        except websocket.WebSocketConnectionClosedException: pass
        c.close()
        a.stop();b.stop()
        print('PASS: two native processes; automatic 502-row paging; independent WS HMAC; forged event rejected; offline old-row edit/delete/add; receiver restart preserves cursor; native CLI restore rotates epoch and replaces divergent history beyond old cursor; socket remains alive after 11 seconds; revocation closes socket; SIGTERM exit0')
    finally:
        a.stop();b.stop();a.log.close();b.log.close()
