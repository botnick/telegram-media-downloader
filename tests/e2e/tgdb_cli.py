from pathlib import Path
import hashlib, io, json, os, sqlite3, subprocess, tarfile, tempfile
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
room=Path(__file__).resolve().parents[2]
scratch=room/"tmp/e2e";scratch.mkdir(parents=True,exist_ok=True)
binary=Path(os.environ.get("TGDL_E2E_BINARY",str(room/"core-service/tgdl-server"))).resolve()
with tempfile.TemporaryDirectory(prefix='tgdb-cli-',dir=scratch) as tmp:
    root=Path(tmp)
    salt=bytes(range(16)); password=b'process fixture password\n'; nonce=bytes(range(12))
    key=hashlib.pbkdf2_hmac('sha256',password,salt,200000,32)
    (root/'pass').write_bytes(password)
    (root/'recovery.json').write_text(json.dumps(dict(format='TGDB',version=1,kdf='PBKDF2-HMAC-SHA256',iterations=200000,saltHex=salt.hex())))
    def seal(data):
        return b'TGDB\x01'+nonce+AESGCM(key).encrypt(nonce,data,None)
    def command(*args,expected=0):
        env=dict(os.environ);env.pop('TGDL_DATA_DIR',None)
        p=subprocess.run([str(binary),*map(str,args)],env=env,capture_output=True,timeout=20)
        assert p.returncode==expected, (p.returncode,p.stderr.decode())
        assert password not in p.stdout+p.stderr
    media=bytes(range(256))*1024
    (root/'input').write_bytes(seal(media))
    flags=['--passphrase-file',root/'pass','--recovery-info',root/'recovery.json']
    command('backup-decrypt','--input',root/'input','--output',root/'media',*flags)
    assert (root/'media').read_bytes()==media
    command('backup-decrypt','--input',root/'input','--output',root/'media',*flags,expected=1)
    corrupt=bytearray((root/'input').read_bytes());corrupt[-1]^=1;(root/'bad').write_bytes(corrupt)
    command('backup-decrypt','--input',root/'bad','--output',root/'never',*flags,expected=1)
    assert not (root/'never').exists()
    db=sqlite3.connect(root/'original.db')
    db.executescript("CREATE TABLE downloads(id INTEGER);CREATE TABLE kv(key TEXT,value TEXT);INSERT INTO kv VALUES('fixture','preserved');")
    db.commit();db.close()
    stream=io.BytesIO()
    with tarfile.open(fileobj=stream,mode='w:gz',format=tarfile.PAX_FORMAT) as archive:
        for name,data in [('db.sqlite',(root/'original.db').read_bytes()),('config.json',b'{}'),('secret.key',b'fixture'),('sessions/native/test.enc',b'fixture-session')]:
            entry=tarfile.TarInfo(name);entry.size=len(data);entry.mode=0o600;archive.addfile(entry,io.BytesIO(data))
    (root/'snapshot').write_bytes(seal(stream.getvalue()))
    command('backup-restore','--input',root/'snapshot','--output',str(root/'restored')+'/',*flags)
    db=sqlite3.connect(root/'restored/db.sqlite')
    assert db.execute("SELECT value FROM kv WHERE key='fixture'").fetchone()==('preserved',)
    assert db.execute('PRAGMA integrity_check').fetchone()==('ok',);db.close()
    assert (root/'restored/sessions/native/test.enc').read_bytes()==b'fixture-session'
    command('backup-restore','--input',root/'snapshot','--output',root/'restored',*flags,expected=1)
    assert not list(root.glob('.tgdb-*'))
print('PASS: native process decrypt/restore, independent Python AESGCM and PAX tar, database contents/integrity, tamper and overwrite rejection, no residual staging')
