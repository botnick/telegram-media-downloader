(function () {
  var copy = document.querySelector('.copy');
  if (copy) copy.addEventListener('click', function () {
    var text = document.querySelector(copy.getAttribute('data-copy')).innerText;
    var idle = copy.textContent, busy = copy.getAttribute('data-done') || 'Copied';
    var done = function () { copy.textContent = busy; setTimeout(function () { copy.textContent = idle; }, 1800); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {});
  });
  try {
    fetch('https://api.github.com/repos/botnick/telegram-media-downloader')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || typeof d.stargazers_count !== 'number') return;
        ['stars', 'stars2'].forEach(function (id) {
          var el = document.getElementById(id);
          el.textContent = d.stargazers_count.toLocaleString(document.documentElement.lang || 'en');
          el.hidden = false;
        });
      }).catch(function () {});
  } catch (e) {}
})();
