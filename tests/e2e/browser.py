from pathlib import Path
import os, json, socket, subprocess, time, shutil, re, tempfile
from playwright.sync_api import sync_playwright, expect
room=Path(__file__).resolve().parents[2]
scratch=room/'tmp/e2e';scratch.mkdir(parents=True,exist_ok=True)
temporary=tempfile.TemporaryDirectory(prefix='browser-',dir=scratch)
root=Path(temporary.name);data=root/'data';data.mkdir()
fresh=True
with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
base=f'http://127.0.0.1:{port}'
log=(root/'server.log').open('w')
p=subprocess.Popen([os.environ.get('TGDL_E2E_BINARY',str(room/'core-service/tgdl-server'))],env=dict(os.environ,TGDL_DATA_DIR=str(data),TGDL_BIND_HOST='127.0.0.1',PORT=str(port),TGDL_SECURE_COOKIES='0'),stdout=log,stderr=log)
results=[]
def record(name,**kw):
    item=dict(test=name,**kw);results.append(item);print(json.dumps(item),flush=True);(root/'results.json').write_text(json.dumps(results,indent=2))
try:
    with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True)
        context=browser.new_context();page=context.new_page();errors=[]
        # Keep actual application/API traffic while making optional external
        # fonts/icons independent of the runner's outbound network and CDN.
        context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(base+'/') else route.abort())
        page.on('pageerror',lambda e:errors.append(str(e)))
        for _ in range(100):
            try:
                if context.request.get(base+'/health').ok:break
            except Exception:time.sleep(.1)
        assert context.request.post(base+('/api/auth/setup' if fresh else '/api/login'),data={'password':'local-e2e-password-3417'}).ok
        assert context.request.post(base+'/api/logout',data={}).ok
        page.goto(base+'/login.html',wait_until='domcontentloaded');page.locator('#password').fill('local-e2e-password-3417');page.locator('#submitBtn').click()
        page.wait_for_url(re.compile(r'.*/(?:index.html)?(?:#.*)?$'),wait_until='domcontentloaded')
        record('real browser login',passed=True)
        for path in ['/api/accounts','/api/stats','/api/groups','/api/queue/snapshot','/api/config','/api/backup/destinations','/api/system/health']:
            r=context.request.get(base+path);assert r.ok,(path,r.status);record(path,status=r.status)
        routes=['viewer','groups','queue','settings','settings/accounts','settings/downloads','settings/appearance','settings/network','settings/tools/library/duplicates','settings/tools/library/thumbs','settings/tools/library/seekbar','settings/tools/library/video','settings/tools/safety/nsfw','settings/tools/safety/ai','settings/tools/sync/backup','settings/tools/sync/cluster']
        for width in [390,1280]:
            page.set_viewport_size({'width':width,'height':900})
            for route in routes:
                page.goto(base+'/#/'+route,wait_until='domcontentloaded')
                expect(page.locator('#page-title')).to_be_visible()
                expect(page.locator('#content-area > [id^="page-"]:visible').first).to_be_visible()
                page.wait_for_timeout(700)
                assert not page.evaluate('document.documentElement.scrollWidth > innerWidth'), (route,width)
                record('browser route',route=route,width=width,overflow=page.evaluate('document.documentElement.scrollWidth > innerWidth'))
            page.screenshot(path=str(root/f'browser-{width}.png'))
        assert not errors,errors
        record('uncaught browser errors',count=len(errors))
        browser.close()
finally:
    p.terminate()
    try:p.wait(timeout=20)
    except subprocess.TimeoutExpired:p.kill();p.wait()
    log.close()
    temporary.cleanup()
