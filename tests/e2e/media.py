from pathlib import Path
import os,json,socket,subprocess,time,http.cookiejar,urllib.request,urllib.error,sqlite3,hashlib,tempfile,io,zipfile
room=Path(__file__).resolve().parents[2]
scratch=room/"tmp/e2e";scratch.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='media-e2e-',dir=scratch) as tmp:
 root=Path(tmp);data=root/'data';downloads=data/'downloads';downloads.mkdir(parents=True)
 fixture=downloads/'fixture ไทย.mp4'
 subprocess.run(['/usr/bin/ffmpeg','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=320x240:rate=12','-t','3','-c:v','mpeg4','-threads','1',str(fixture)],check=True)
 expected=fixture.read_bytes()
 with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
 base=f'http://127.0.0.1:{port}';opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
 def request(path,body=None,method=None,headers=None,anon=False):
  req=urllib.request.Request(path if path.startswith('http') else base+path,data=None if body is None else json.dumps(body).encode(),method=method,headers={'Content-Type':'application/json','Origin':base,**(headers or {})})
  try:r=(urllib.request.urlopen if anon else opener.open)(req,timeout=90)
  except urllib.error.HTTPError as e:r=e
  with r:return r.status,r.read(),dict(r.headers)
 def api(path,body=None,method=None):
  status,raw,_=request(path,body,method);assert status==200,(path,status,raw[:300]);return json.loads(raw)
 log=(root/'server.log').open('w');p=subprocess.Popen([os.environ.get('TGDL_E2E_BINARY',str(room/'core-service/tgdl-server'))],env=dict(os.environ,TGDL_DATA_DIR=str(data),TGDL_BIND_HOST='127.0.0.1',PORT=str(port),TGDL_SECURE_COOKIES='0'),stdout=log,stderr=log)
 try:
  for _ in range(100):
   try:request('/health');break
   except OSError:time.sleep(.1)
  api('/api/auth/setup',{'password':'media-e2e-password'})
  with sqlite3.connect(data/'db.sqlite') as db:
   db.execute("INSERT INTO downloads(id,group_id,message_id,file_name,file_path,file_size,file_type,status,file_hash) VALUES(1,'fixture',1,?,?,?,'video','completed',?)",(fixture.name,fixture.name,len(expected),hashlib.sha256(expected).hexdigest()))
  assert api('/api/downloads/all')['total']==1
  assert api('/api/downloads/search?q=fixture')['total']==1
  path='/files/'+urllib.parse.quote(fixture.name)
  status,raw,h=request(path,headers={'Range':'bytes=10-99'});assert status==206 and raw==expected[10:100]
  print('PASS catalog/search and actual byte range',flush=True)
  status,raw,_=request('/api/downloads/bulk-zip',{'ids':[1]});assert status==200
  with zipfile.ZipFile(io.BytesIO(raw)) as z:assert z.read(z.namelist()[0])==expected
  print('PASS ZIP export bytes',flush=True)
  link=api('/api/share/links',{'downloadId':1,'ttlSeconds':600})['link']
  status,raw,_=request(link['url'],anon=True);assert status==200 and raw==expected
  api('/api/share/links/'+str(link['id']),method='DELETE')
  status,raw,_=request(link['url'],anon=True);assert status==401 and json.loads(raw)['code']=='revoked'
  print('PASS anonymous signed share and revoke',flush=True)
  result=api('/api/maintenance/seekbar/regen/1',{})
  assert result.get('success') and not result.get('skipped'),result
  assert request('/api/seekbar/meta/1')[0]==200
  status,raw,h=request('/api/seekbar/sprite/1');assert status==200 and len(raw)>100
  print('PASS actual FFmpeg seekbar generation, metadata and sprite delivery',flush=True)
  api('/api/auth/guest-password',{'password':'media-guest-password'})
  api('/api/logout',{});api('/api/login',{'password':'media-guest-password'})
  assert request('/api/config',{})[0]==403
  assert request('/api/share/links',{'downloadId':1})[0]==403
  print('PASS guest mutation restrictions',flush=True)
 finally:
  p.terminate()
  try:p.wait(timeout=20)
  except subprocess.TimeoutExpired:p.kill();p.wait()
  log.close()
