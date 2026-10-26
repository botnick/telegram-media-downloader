from pathlib import Path
import hashlib,http.cookiejar,json,os,socket,subprocess,tempfile,time,urllib.request,urllib.error
room=Path(__file__).resolve().parents[2]
scratch=room/"tmp/e2e";scratch.mkdir(parents=True,exist_ok=True)
binary=Path(os.environ.get("TGDL_E2E_BINARY",str(room/"core-service/tgdl-server"))).resolve()
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kw):return None
with tempfile.TemporaryDirectory(prefix='http-policy-',dir=scratch) as tmp:
    root=Path(tmp);data=root/'data';data.mkdir()
    reserve=socket.socket();reserve.bind(('127.0.0.1',0));port=reserve.getsockname()[1];reserve.close()
    base=f'http://127.0.0.1:{port}';cookies=http.cookiejar.CookieJar()
    opener=urllib.request.build_opener(NoRedirect,urllib.request.HTTPCookieProcessor(cookies),urllib.request.ProxyHandler({}))
    log=open(root/'server.log','wb');process=None
    def start(secure):
        global process
        env=dict(os.environ,TGDL_DATA_DIR=str(data),PORT=str(port),TGDL_SECURE_COOKIES=str(secure),COMPRESSION_LEVEL='6',TRUST_PROXY='loopback')
        env.pop('TGDL_CSP',None)
        process=subprocess.Popen([str(binary)],env=env,stdout=log,stderr=log)
        for _ in range(100):
            assert process.poll() is None,'application exited during startup'
            try:
                status,_,_=request('GET','/api/version')
                if status==200:return
            except OSError:pass
            time.sleep(.05)
        raise AssertionError('application readiness timeout')
    def stop():
        global process
        if process is not None:
            process.terminate()
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait();raise
            process=None
    def request(method,path,body=None,headers=None):
        raw=None if body is None else json.dumps(body).encode()
        h={'Content-Type':'application/json','Origin':base};h.update(headers or {})
        req=urllib.request.Request(base+path,data=raw,method=method,headers=h)
        try:res=opener.open(req,timeout=10)
        except urllib.error.HTTPError as e:res=e
        with res:return res.status,res.headers,res.read()
    def save(web):
        status,_,body=request('POST','/api/config',{'web':web});assert status==200,(status,body)
    try:
        start(0)
        assert request('POST','/api/auth/setup',{'password':'fixture-http-admin'})[0]==200
        status,_,plain=request('GET','/index.html');assert status==200
        token=next(c.value for c in cookies if c.name=='tg_dl_session')
        for encoding in ['gzip','deflate','br']:
            head=root/(encoding+'.headers')
            result=subprocess.run(['curl','--silent','--show-error','--fail','--max-time','10','--noproxy','*','--compressed','-H',f'Accept-Encoding: {encoding}','-H',f'Cookie: tg_dl_session={token}','-D',str(head),base+'/index.html'],capture_output=True,check=True)
            assert result.stdout==plain,encoding+' decoded content differs'
            assert f'Content-Encoding: {encoding}'.lower() in head.read_text().lower(),encoding+' not negotiated'
        save({'forceHttps':True})
        status,h,body=request('GET','/api/version?x=1',headers={'X-Forwarded-For':'203.0.113.9'})
        assert status==308 and h['Location']==base.replace('http:','https:')+'/api/version?x=1'
        assert request('POST','/api/config',{'web':{'forceHttps':False}},{'X-Forwarded-For':'203.0.113.9'})[0]==403
        status,h,_=request('GET','/api/version',headers={'X-Forwarded-For':'203.0.113.9','X-Forwarded-Proto':'https'})
        assert status==200 and '31536000' in h['Strict-Transport-Security'] and 'upgrade-insecure-requests' in h['Content-Security-Policy']
        save({'forceHttps':False,'csp':{'reportOnly':True,'directives':{'frame-ancestors':['https://embed.example']}}})
        status,h,_=request('GET','/api/version');assert status==200 and 'Content-Security-Policy-Report-Only' in h and 'X-Frame-Options' not in h
        save({'csp':None,'rateLimit':{'enabled':True,'perMinute':10}})
        for _ in range(10):assert request('GET','/api/version',headers={'X-Forwarded-For':'203.0.113.19'})[0]==200
        status,h,_=request('GET','/api/version',headers={'X-Forwarded-For':'203.0.113.19'});assert status==429 and 'Retry-After' in h
        save({'rateLimit':{'enabled':False}})
        stop();start(1)
        status,h,_=request('POST','/api/login',{'password':'fixture-http-admin'});assert status==200 and 'Secure' in h['Set-Cookie']
        print('PASS: native HTTP process, independent curl/zlib/Brotli decoders preserve SPA bytes, live forceHTTPS/CSP/rate-limit changes, remote mutation refusal, HTTPS headers, Secure cookie on restart')
    finally:
        stop();log.close()
