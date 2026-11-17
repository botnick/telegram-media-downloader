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
    assert 'id="fwd-scan-route"' in source
    assert all(f'value="{mode}"' in source for mode in ('download', 'direct', 'both'))
    scan_route_patch = page.evaluate('''() => {
      const originalTimeout = window.setTimeout;
      window.setTimeout = () => 0;
      cur = {id:'-10001', group:{autoForward:{enabled:true}}};
      pending = null;
      const select = document.createElement('select');
      select.id = 'fwd-scan-route';
      select.innerHTML = '<option value="download"></option><option value="direct"></option><option value="both"></option>';
      select.value = 'both';
      void onChange({target:select});
      const saved = pending;
      window.setTimeout = originalTimeout;
      return saved;
    }''')
    assert scan_route_patch['autoForward']['scanRoute'] == 'both', scan_route_patch
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
    # Large monitored-chat destination search must remain bounded without
    # dropping the canonical native select options or the chosen destination.
    page.evaluate('''() => {
      state.allDialogs = Array.from({length: 5000}, (_, i) => ({
        id: String(-1000000 - i), name: 'Target ' + String(i).padStart(4, '0')
      }));
      window.routesHarness.setup();
      document.addEventListener('click', onClick);
      document.addEventListener('input', onInput);
      const select = document.querySelector('[data-route-destination]');
      select.innerHTML = forwardGroupOptions('-10042');
      cacheSearchOptions(select);
    }''')
    result = page.evaluate('''() => {
      const select = document.querySelector('[data-route-destination]');
      const initial = select.options.length;
      filterSearchOptions(select, 'Target');
      const shown = document.querySelectorAll('[data-route-destination]')?.length;
      const rendered = select.closest('[data-search-select]').querySelectorAll('[data-select-option]').length;
      return {initial, after: select.options.length, rendered, selected: select.value};
    }''')
    assert result['initial'] > 5000, result
    assert result['after'] == result['initial'], result
    assert result['rendered'] == 100, result
    assert result['selected'] == '-10042', result
    page.evaluate('''() => {
      const select = document.querySelector('[data-route-destination]');
      filterSearchOptions(select, 'Target 4999');
    }''')
    assert page.locator('[data-select-option][data-select-option="-1004999"]').count() == 1
    # Selecting a result beyond the first page must propagate through the
    # delegated click handler, keep the chosen value, and survive filtering.
    # The menu starts closed in the test fixture: open it through the real
    # trigger before using a user-visible Playwright click.
    page.locator('[data-route-destination]').locator('xpath=..').locator('[data-select-trigger]').click()
    page.locator('[data-route-destination]').locator('xpath=..').locator('[data-option-search]').fill('Target 4999')
    page.locator('[data-select-option][data-select-option="-1004999"]').click()
    assert page.locator('[data-route-destination]').input_value() == '-1004999'
    page.evaluate('''() => {
      const select = document.querySelector('[data-route-destination]');
      filterSearchOptions(select, 'No existing destination');
    }''')
    assert page.locator('[data-route-destination]').input_value() == '-1004999'
    assert page.locator('[data-select-option]').count() == 0
    # Rendering many routes against the issue-sized dialog list should reuse
    # one sorted destination list while preserving each route's selection.
    route_render = page.evaluate('''() => {
      state.allDialogs = Array.from({length: 1000}, (_, i) => ({
        id: String(-2000000 - i), name: 'Dialog ' + String(i).padStart(4, '0')
      }));
      const started = performance.now();
      const destinations = forwardGroupDestinations();
      const html = Array.from({length: 10}, (_, i) => forwardRouteHtml({
        destinationGroupId: String(-2000000 - i)
      }, i, destinations)).join('');
      document.body.innerHTML = html;
      const elapsedMs = performance.now() - started;
      const selects = [...document.querySelectorAll('[data-route-destination]')];
      return {
        elapsedMs,
        destinations: destinations.length,
        routes: selects.length,
        selected: selects.map((select) => select.value),
        optionCounts: selects.map((select) => select.options.length),
      };
    }''')
    assert route_render['routes'] == 10, route_render
    assert route_render['destinations'] >= 1000, route_render
    assert all(count >= 1000 for count in route_render['optionCounts']), route_render
    assert route_render['selected'] == [str(-2000000 - i) for i in range(10)], route_render
    print(f"PERF: 1000 dialogs × 10 routes rendered in {route_render['elapsedMs']:.1f}ms")
    # Duplicate route rules must disable conflicting options without
    # disabling the currently selected value of the same route.
    conflicts = page.evaluate('''() => {
      const routes = document.createElement('div');
      routes.id = 'fwd-routes';
      routes.innerHTML = forwardRouteHtml({sourceTopicId:10,destinationGroupId:'-10042'},0)
        + forwardRouteHtml({sourceTopicId:11,destinationGroupId:'-10042'},1);
      document.body.replaceChildren(routes);
      for (const [index, card] of [...routes.querySelectorAll('[data-forward-route]')].entries()) {
        const source = card.querySelector('[data-route-source-topic]');
        source.innerHTML = '<option value="0">All</option><option value="10">A</option><option value="11">B</option>';
        source.value = String(index === 0 ? 10 : 11);
        cacheSearchOptions(source);
        const destination = card.querySelector('[data-route-destination]');
        cacheSearchOptions(destination);
      }
      updateRouteWildcardState();
      return [...routes.querySelectorAll('[data-forward-route]')].map((card) => {
        const source = card.querySelector('[data-route-source-topic]');
        return {
          own: source.options[source.selectedIndex]?.disabled,
          ten: [...source.options].find(o => o.value === '10').disabled,
          eleven: [...source.options].find(o => o.value === '11').disabled,
        };
      });
    }''')
    assert conflicts == [
        {'own': False, 'ten': False, 'eleven': True},
        {'own': False, 'ten': True, 'eleven': False},
    ], conflicts
    browser.close()
print('PASS: route preservation and 5000-dialog bounded search regression')
