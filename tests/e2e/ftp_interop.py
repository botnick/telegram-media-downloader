"""Actual native app + independent FTP/FTPS server + encrypted backup restore.
Requires pyftpdlib, pyOpenSSL and cryptography; TGDL_E2E_BINARY selects the app.
No Telegram credentials or external storage needed.
"""
from pathlib import Path
import sys
room=Path(__file__).resolve().parents[2]

import datetime, hashlib, http.cookiejar, ipaddress, json, logging, os, socket, sqlite3, subprocess, tempfile, time, urllib.request
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

if len(sys.argv)>1 and sys.argv[1]=='serve':
    from pyftpdlib.authorizers import DummyAuthorizer
    from pyftpdlib.handlers import FTPHandler, TLS_FTPHandler
    from pyftpdlib.servers import FTPServer
    mode,root,cert,key,portfile=sys.argv[2:]
    logging.basicConfig(level=logging.ERROR)
    authorizer=DummyAuthorizer();authorizer.add_user('fixture','fixture-pass',root,perm='elradfmwMT')
    base=TLS_FTPHandler if mode=='control' else FTPHandler
    class Handler(base): pass
    Handler.authorizer=authorizer
    if mode=='control':
        Handler.certfile=cert;Handler.keyfile=key;Handler.tls_control_required=True;Handler.tls_data_required=True
    server=FTPServer(('127.0.0.1',0),Handler)
    Path(portfile).write_text(str(server.socket.getsockname()[1]))
    server.serve_forever()
    sys.exit(0)

binary=Path(os.environ.get('TGDL_E2E_BINARY', str(room/'core-service/tgdl-server'))).resolve()
scratch=room/'tmp/e2e';scratch.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='ftp-interop-',dir=scratch) as temporary:
    root=Path(temporary); processes=[]; handles=[]
    try:
        key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        subject=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'loopback FTP fixture')])
        now=datetime.datetime.now(datetime.timezone.utc)
        cert=(x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key()).serial_number(13)
              .not_valid_before(now-datetime.timedelta(hours=1)).not_valid_after(now+datetime.timedelta(hours=1))
              .add_extension(x509.BasicConstraints(ca=True,path_length=None),critical=True)
              .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False).sign(key,hashes.SHA256()))
        (root/'cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        (root/'key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
        ports={}
        for mode in ['false','control']:
            remote=root/mode;remote.mkdir();portfile=root/(mode+'.port')
            log=open(root/(mode+'.log'),'wb');handles.append(log)
            process=subprocess.Popen([sys.executable,__file__,'serve',mode,str(remote),str(root/'cert.pem'),str(root/'key.pem'),str(portfile)],stdout=log,stderr=log);processes.append(process)
            for _ in range(100):
                if portfile.exists():break
                assert process.poll() is None, (root/(mode+'.log')).read_text()
                time.sleep(.05)
            ports[mode]=int(portfile.read_text())
        reserve=socket.socket();reserve.bind(('127.0.0.1',0));httpport=reserve.getsockname()[1];reserve.close()
        data=root/'data';data.mkdir();env=dict(os.environ,TGDL_DATA_DIR=str(data),PORT=str(httpport),TGDL_SECURE_COOKIES='0')
        log=open(root/'app.log','wb');handles.append(log)
        app=subprocess.Popen([str(binary)],env=env,stdout=log,stderr=log);processes.append(app)
        cookies=http.cookiejar.CookieJar();opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies));base=f'http://127.0.0.1:{httpport}'
        def request(method,path,body=None):
            raw=None if body is None else json.dumps(body).encode()
            req=urllib.request.Request(base+path,data=raw,method=method,headers={'Content-Type':'application/json','Origin':base})
            with opener.open(req,timeout=15) as response:return json.load(response)
        for _ in range(100):
            try:
                request('GET','/api/version');break
            except (OSError,urllib.error.HTTPError):time.sleep(.05)
        assert request('POST','/api/auth/setup',{'password':'fixture-admin-pass'})['success']
        destinations={}
        for mode in ports:
            cfg=dict(host='127.0.0.1',port=ports[mode],username='fixture',password='fixture-pass',remoteRoot='/mirror',secure=mode)
            if mode=='control':cfg['tlsCA']=(root/'cert.pem').read_text()
            result=request('POST','/api/backup/destinations',dict(name=mode,provider='ftp',config=cfg,mode='mirror'));destinations[mode]=result['id']
            result=request('POST',f"/api/backup/destinations/{result['id']}/test",{})
            assert result.get('ok') is True,result
        encrypted=destinations['control']
        assert request('POST',f'/api/backup/destinations/{encrypted}/encryption',{'enabled':True,'passphrase':'fixture-media-pass'})['success']
        recovery=request('GET',f'/api/backup/destinations/{encrypted}/recovery')['recovery']
        encryptionkey=hashlib.pbkdf2_hmac('sha256',b'fixture-media-pass',bytes.fromhex(recovery['saltHex']),200000,32)
        name='ไทย/media.bin';source=data/'downloads'/name;source.parent.mkdir(parents=True,exist_ok=True)
        expected=bytes(range(256))*4096
        source.write_bytes(expected)
        db=sqlite3.connect(data/'db.sqlite');db.execute("INSERT INTO downloads(group_id,message_id,file_name,file_path,file_size,file_hash) VALUES('interop',1,'media.bin',?,?,?)",(name,len(expected),hashlib.sha256(expected).hexdigest()));db.commit()
        def wait_bytes(content):
            for _ in range(200):
                try:
                    plain=(root/'false/mirror'/name).read_bytes();encrypted=(root/'control/mirror'/name).read_bytes()
                    if plain==content and encrypted[:5]==b'TGDB\x01' and AESGCM(encryptionkey).decrypt(encrypted[5:17],encrypted[17:],None)==content:return
                except (OSError,ValueError):pass
                time.sleep(.05)
            raise AssertionError('mirror did not converge: '+str(request('GET','/api/backup/jobs/recent')))
        wait_bytes(expected)
        expected=b'!'+expected[1:];source.write_bytes(expected);db.execute("UPDATE downloads SET file_hash=? WHERE group_id='interop'",(hashlib.sha256(expected).hexdigest(),));db.commit();wait_bytes(expected)
        cfg=dict(host='127.0.0.1',port=ports['control'],username='fixture',password='fixture-pass',remoteRoot='/snapshot-backup',secure='control',tlsCA=(root/'cert.pem').read_text())
        snap=request('POST','/api/backup/destinations',dict(name='snapshot interop',provider='ftp',config=cfg,mode='manual'))['id']
        request('POST',f'/api/backup/destinations/{snap}/run',{})
        for _ in range(200):
            jobs=request('GET',f'/api/backup/destinations/{snap}/jobs')['jobs']
            if jobs and jobs[0]['status']=='done':break
            time.sleep(.05)
        assert jobs and jobs[0]['status']=='done',jobs
        saved=root/'control/snapshot-backup'/jobs[0]['remote_path'];restored=root/'restored'
        subprocess.run([str(binary),'backup-restore','--input',str(saved),'--output',str(restored),'--plaintext'],check=True,capture_output=True,timeout=20)
        restoredb=sqlite3.connect(restored/'db.sqlite');assert restoredb.execute('PRAGMA integrity_check').fetchone()==('ok',);assert restoredb.execute("SELECT file_hash FROM downloads WHERE group_id='interop'").fetchone()==(hashlib.sha256(expected).hexdigest(),);restoredb.close()
        assert db.execute('SELECT count(*) FROM native_backup_transfers').fetchone()==(0,);db.close()
        assert not list((root/'false').rglob('.tgdl-ftp-*')) and not list((root/'control').rglob('.tgdl-ftp-*'))
        assert all(j['attempts']==1 for j in request('GET','/api/backup/jobs/recent')['jobs']), 'unexpected upload retry'
        print('PASS: independent pyftpdlib 2.2.0 plain FTP + explicit FTPS, native HTTP setup/probes, automatic 1 MiB mirrors, TGDB encryption, equal-size edit, snapshot upload and native restore; no staging/journal remains')
    finally:
        for process in reversed(processes):
            process.terminate()
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait()
        for handle in handles:handle.close()
