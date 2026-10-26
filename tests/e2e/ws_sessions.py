from pathlib import Path
import base64, hashlib, http.client, json, os, secrets, socket, sqlite3, subprocess, tempfile, time
room=Path(__file__).resolve().parents[2]
scratch=room/"tmp/e2e";scratch.mkdir(parents=True,exist_ok=True)
binary=Path(os.environ.get("TGDL_E2E_BINARY",str(room/"core-service/tgdl-server"))).resolve()
with tempfile.TemporaryDirectory(prefix='ws-sessions-',dir=scratch) as tmp:
    root=Path(tmp); data=root/'data'; data.mkdir()
    reserve=socket.socket();reserve.bind(('127.0.0.1',0));port=reserve.getsockname()[1];reserve.close()
    log=open(root/'server.log','wb'); process=None; sockets=[]
    def request(path,body=None,token=None):
        c=http.client.HTTPConnection('127.0.0.1',port,timeout=5)
        headers={'Content-Type':'application/json'}
        if token:headers['Cookie']='tg_dl_session='+token
        c.request('GET' if body is None else 'POST',path,body=None if body is None else json.dumps(body),headers=headers)
        r=c.getresponse(); raw=r.read(); status=r.status; cookie=r.getheader('Set-Cookie'); c.close()
        return status,json.loads(raw),None if cookie is None else cookie.split(';',1)[0].split('=',1)[1]
    def start():
        global process
        env=dict(os.environ,TGDL_DATA_DIR=str(data),PORT=str(port),TGDL_SECURE_COOKIES='0',TRUST_PROXY='loopback')
        process=subprocess.Popen([str(binary)],env=env,stdout=log,stderr=log)
        for _ in range(100):
            assert process.poll() is None,'startup failed'
            try:
                if request('/api/version')[0]==200:return
            except OSError:pass
            time.sleep(.05)
        raise AssertionError('startup timeout')
    def stop():
        global process
        if process:
            process.terminate()
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait();raise
            assert process.returncode==0,process.returncode
            process=None
    def ws(token):
        s=socket.create_connection(('127.0.0.1',port),timeout=3);sockets.append(s)
        key=base64.b64encode(secrets.token_bytes(16)).decode()
        s.sendall((f'GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\nCookie: tg_dl_session={token}\r\n\r\n').encode())
        header=b''
        while not header.endswith(b'\r\n\r\n'):
            b=s.recv(1);assert b,'handshake ended';header+=b
        assert header.startswith(b'HTTP/1.1 101'),header
        expected=base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
        assert expected in header,'incorrect WebSocket accept'
        return s
    def closed(s):
        assert s.recv(1)==b'','data received after revocation'
        s.close()
    def token_check(token,expected):
        status,body,_=request('/api/auth_check',token=token)
        assert status==200 and body['authenticated']==expected,(status,body)
    try:
        start()
        status,_,admin=request('/api/auth/setup',{'password':'fixture-admin-password'});assert status==200
        _,_,other=request('/api/login',{'password':'fixture-admin-password'})
        a1,a2=ws(admin),ws(admin)
        assert request('/api/logout',{},admin)[0]==200
        closed(a1);closed(a2);token_check(admin,False);token_check(other,True)
        assert request('/api/auth/guest-password',{'password':'fixture-guest-password'},other)[0]==200
        _,_,guest=request('/api/login',{'password':'fixture-guest-password'})
        gs=ws(guest)
        assert request('/api/auth/guest-password',{'enabled':False},other)[0]==200
        closed(gs);token_check(guest,False);token_check(other,True)
        osock=ws(other)
        status,_,fresh=request('/api/auth/change-password',{'currentPassword':'fixture-admin-password','newPassword':'replacement-admin-password'},other)
        assert status==200
        closed(osock);token_check(other,False);token_check(fresh,True)
        short=secrets.token_hex(32);now=int(time.time()*1000)
        with sqlite3.connect(data/'db.sqlite') as db:
            db.execute('INSERT INTO web_sessions(token,role,issued_at,expires_at,last_seen) VALUES(?,?,?,?,?)',(short,'admin',now,now+1500,now))
        closed(ws(short));token_check(short,False)
        live=ws(fresh);stop();closed(live)
        start();token_check(fresh,True)
        final=ws(fresh);stop();closed(final)
        print('PASS: native executable, independent raw RFC6455 handshake, logout/multiple tabs, guest disable, password rotation, short-lived expiry, SIGTERM closes sockets and exits0, persisted replacement session after restart')
    finally:
        stop()
        for s in sockets:s.close()
        log.close()
