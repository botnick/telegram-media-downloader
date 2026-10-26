"""Browser regression checks: python3 tests/ui/forum_routes.py (requires Playwright Chromium)."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[2]
public = root / 'core-service/internal/webassets/public'
source = (public / 'js/chat-details.js').read_text()
source = re.sub(r'^import\s[\s\S]*?;\n', '', source, flags=re.M)
source = re.sub(r'^export ', '', source, flags=re.M)
prelude = '''
const i18nT = (key, fallback) => fallback || key;
const i18nTf = (key, values, fallback) => Object.entries(values).reduce((s,[k,v])=>s.replaceAll('{'+k+'}',v),fallback);
const escapeHtml = (s) => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const state = { allDialogs: [{id:'-10042',name:'Archive'}], config: {groups:[]} };
const getGroupName = (id, options) => options?.fallback || id;
const api = {get: async () => { throw Error('offline'); }};
'''
harness = '''
window.routesHarness = {
 setup() {
  cur = {id:'-10001',name:'Source',group:{topics:{enabled:false,ids:[]}}};
  document.body.innerHTML = forwardRouteHtml({sourceTopicId:10,destinationGroupId:'-10042',destinationTopicId:20,captionMode:'override',caption:'Keep this caption'});
 },
 async fail() {
  await loadTopicOptions(document.querySelector('[data-route-source-topic]'),'-10001','All topics');
  await loadTopicOptions(document.querySelector('[data-route-destination-topic]'),'-10042','No topic',true);
  return collectForwardRoutes();
 },
 async missing() {
  forumTopicsCache.clear(); api.get = async () => ({topics:[]});
  await loadTopicOptions(document.querySelector('[data-route-source-topic]'),'-10001','All topics');
  return collectForwardRoutes();
 },
 async success() {
  forumTopicsCache.clear(); api.get = async () => ({topics:[{id:10,name:'Photos'},{id:11,name:'Videos'}]});
  await loadTopicOptions(document.querySelector('[data-route-source-topic]'),'-10001','All topics');
  return collectForwardRoutes();
 },
 collect: collectForwardRoutes,
};
'''
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_content('<html><head></head><body></body></html>')
    for css in ('tailwind.css', 'main.css'):
        page.add_style_tag(content=(public / 'css' / css).read_text())
    page.add_script_tag(content=prelude + source + harness)
    for width in (390, 1280):
        page.set_viewport_size({'width': width, 'height': 900})
        page.evaluate('routesHarness.setup()')
        for operation in ('fail', 'missing', 'success'):
            routes = page.evaluate(f'routesHarness.{operation}()')
            assert routes[0]['sourceTopicId'] == 10, routes
            assert routes[0]['destinationTopicId'] == 20, routes
            assert routes[0]['caption'] == 'Keep this caption', routes
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'overflow at {width}'
        page.locator('[data-forward-route]').evaluate('(el) => el.remove()')
        assert page.evaluate('routesHarness.collect()') == []
    browser.close()
print('PASS: mobile/desktop route IDs and captions survive failed, empty and successful topic lookup; removing all routes saves an empty list')
