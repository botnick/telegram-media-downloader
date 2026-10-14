(function () {
  var REPO = 'botnick/telegram-media-downloader';
  var lang = document.documentElement.lang || 'en';
  var copy = document.querySelector('.copy');
  if (copy) copy.addEventListener('click', function () {
    var text = document.querySelector(copy.getAttribute('data-copy')).innerText;
    var idle = copy.textContent, busy = copy.getAttribute('data-done') || 'Copied';
    var done = function () { copy.textContent = busy; setTimeout(function () { copy.textContent = idle; }, 1800); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {});
  });

  var day = function (iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(lang, { day: 'numeric', month: 'short', year: 'numeric' });
  };
  var ago = function (iso) {
    var s = (new Date(iso) - Date.now()) / 1000;
    if (isNaN(s) || typeof Intl.RelativeTimeFormat !== 'function') return day(iso);
    var f = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
    var a = Math.abs(s);
    if (a < 3600) return f.format(Math.round(s / 60), 'minute');
    if (a < 86400) return f.format(Math.round(s / 3600), 'hour');
    return f.format(Math.round(s / 86400), 'day');
  };
  document.querySelectorAll('#rel-list time').forEach(function (t) { t.textContent = day(t.getAttribute('datetime')); });
  var pushed = document.getElementById('rel-pushed');
  if (pushed && pushed.getAttribute('datetime')) pushed.textContent = ago(pushed.getAttribute('datetime'));

  var json = function (url) { return fetch(url).then(function (r) { return r.ok ? r.json() : null; }); };
  try {
    json('https://api.github.com/repos/' + REPO).then(function (d) {
      if (!d || typeof d.stargazers_count !== 'number') return;
      var n = d.stargazers_count.toLocaleString(lang);
      ['stars', 'stars2'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) { el.textContent = n; el.hidden = false; }
      });
      var set = function (id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
      set('rel-stars', n);
      set('rel-forks', d.forks_count.toLocaleString(lang));
      if (pushed) { pushed.setAttribute('datetime', d.pushed_at); pushed.textContent = ago(d.pushed_at); }
    }).catch(function () {});

    // The newest releases and their headline, straight from CHANGELOG.md on main.
    var list = document.getElementById('rel-list');
    if (list) fetch('https://raw.githubusercontent.com/' + REPO + '/main/CHANGELOG.md')
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (md) {
        var re = /^## \[(\d+\.\d+\.\d+)\][^\n]*?(\d{4}-\d{2}-\d{2})[^\n]*$/gm, m, heads = [];
        while ((m = re.exec(md)) && heads.length < 5) heads.push({ v: m[1], date: m[2], at: m.index + m[0].length });
        var items = heads.slice(0, 4).map(function (h, i) {
          var body = md.slice(h.at, i + 1 < heads.length ? heads[i + 1].at : undefined);
          var b = /\*\*(.+?)\*\*/.exec(body);
          var what = b ? b[1].replace(/`/g, '').replace(/[.:]$/, '') : 'v' + h.v;
          var li = document.createElement('li');
          var a = document.createElement('a');
          a.href = 'https://github.com/' + REPO + '/releases/tag/v' + h.v;
          var add = function (cls, text, tag) {
            var el = document.createElement(tag || 'span');
            el.className = cls; el.textContent = text; a.appendChild(el); return el;
          };
          add('tag', 'v' + h.v);
          add('what', what);
          var when = add('when', '');
          var t = document.createElement('time');
          t.setAttribute('datetime', h.date); t.textContent = day(h.date + 'T00:00:00');
          when.appendChild(t);
          li.appendChild(a);
          return li;
        });
        if (items.length) list.replaceChildren.apply(list, items);
      }).catch(function () {});
  } catch (e) {}
})();
