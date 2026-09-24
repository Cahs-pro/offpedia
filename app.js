/* ==========================================================================
   OFFPEDIA — app.js
   Sections: 1 config · 2 state · 3 storage · 4 i18n · 5 theme · 6 network
             7 data · 8 search · 9 dom helpers · 10 images · 11 views
             12 router · 13 service worker · 14 init
   ========================================================================== */
(function () {
  'use strict'; 

  /* ---------------------------------------------------------------- 1 config */

  var STORAGE_KEYS = { lang: 'offpedia.lang', theme: 'offpedia.theme' };

  /* The 10 categories are fixed. Display names live in language.json under
     "categories.<slug>"; icons are plain Unicode so no asset files are needed. */
  var CATEGORIES = [
    { slug: 'science',    icon: '\uD83D\uDD2C' },
    { slug: 'technology', icon: '\uD83D\uDCA1' },
    { slug: 'history',    icon: '\uD83C\uDFDB' },
    { slug: 'geography',  icon: '\uD83D\uDDFA' },
    { slug: 'space',      icon: '\uD83E\uDE90' },
    { slug: 'animals',    icon: '\uD83E\uDD81' },
    { slug: 'human-body', icon: '\uD83E\uDEC0' },
    { slug: 'sports',     icon: '\u26BD' },
    { slug: 'countries',  icon: '\uD83C\uDFF3' },
    { slug: 'culture',    icon: '\uD83C\uDFAD' }
  ];

  var SUPPORTED_LANGS = ['az', 'en', 'zh', 'de', 'ru'];
  var FALLBACK_LANG = 'en';
  var SEARCH_DEBOUNCE_MS = 150;
  var FIELD_WEIGHT = { title: 10, description: 4, content: 1 };

  /* ----------------------------------------------------------------- 2 state */

  var state = {
    lang: FALLBACK_LANG,
    strings: {},           /* { lang: { key: value } } */
    articles: [],          /* every valid article, in file order */
    byId: new Map(),
    byCategory: {},        /* slug -> array of articles */
    failedCategories: [],  /* slugs whose JSON was missing/malformed */
    loaded: false,
    online: true,
    currentArticleId: null
  };

  var els = {};
  var searchTimer = null;
  var swWarned = false;

  /* --------------------------------------------------------------- 3 storage */

  function readStore(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeStore(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }

  /* ------------------------------------------------------------------ 4 i18n */

  function detectLang() {
    var stored = readStore(STORAGE_KEYS.lang);
    if (stored && SUPPORTED_LANGS.indexOf(stored) !== -1) { return stored; }
    var nav = (navigator.languages && navigator.languages.length)
      ? navigator.languages
      : [navigator.language || ''];
    for (var i = 0; i < nav.length; i++) {
      var code = String(nav[i] || '').toLowerCase();
      var base = code.split('-')[0];
      if (base === 'zh') { return 'zh'; }
      if (SUPPORTED_LANGS.indexOf(base) !== -1) { return base; }
    }
    return FALLBACK_LANG;
  }

  /* t('key', { n: 4 }) — falls back to English, then to the key itself. */
  function t(key, params) {
    var table = state.strings[state.lang];
    var value = table && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
    if (typeof value !== 'string') {
      var fb = state.strings[FALLBACK_LANG];
      value = fb && Object.prototype.hasOwnProperty.call(fb, key) ? fb[key] : undefined;
    }
    if (typeof value !== 'string') { return key; }
    if (params) {
      value = value.replace(/\{(\w+)\}/g, function (match, name) {
        return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
      });
    }
    return value;
  }

  function categoryName(slug) { return t('categories.' + slug); }

  function applyStaticTranslations() {
    document.documentElement.setAttribute('lang', state.lang);
    document.title = 'OFFPEDIA — ' + t('app.tagline');

    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
    }
    /* data-i18n-attr="placeholder|search.placeholder,aria-label|search.label" */
    var attrNodes = document.querySelectorAll('[data-i18n-attr]');
    for (var j = 0; j < attrNodes.length; j++) {
      var pairs = attrNodes[j].getAttribute('data-i18n-attr').split(',');
      for (var k = 0; k < pairs.length; k++) {
        var parts = pairs[k].split('|');
        if (parts.length === 2) { attrNodes[j].setAttribute(parts[0].trim(), t(parts[1].trim())); }
      }
    }
    updateNetworkLabel();
  }

  function setLanguage(lang, opts) {
    if (SUPPORTED_LANGS.indexOf(lang) === -1) { lang = FALLBACK_LANG; }
    state.lang = lang;
    writeStore(STORAGE_KEYS.lang, lang);
    if (els.langSelect) { els.langSelect.value = lang; }
    applyStaticTranslations();
    if (!opts || opts.render !== false) { renderRoute(); }
  }

  function loadLanguageFile() {
    return fetchJSON('./language.json').then(function (data) {
      if (!data || typeof data !== 'object') { throw new Error('bad language file'); }
      var out = {};
      SUPPORTED_LANGS.forEach(function (code) {
        out[code] = (data[code] && typeof data[code] === 'object') ? data[code] : {};
      });
      state.strings = out;
    })['catch'](function (err) {
      console.warn('OFFPEDIA: language.json could not be loaded.', err);
      state.strings = {};
    });
  }

  /* ----------------------------------------------------------------- 5 theme */

  function systemPrefersDark() {
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches; }
    catch (e) { return false; }
  }

  function applyTheme(pref) {
    if (['light', 'dark', 'system'].indexOf(pref) === -1) { pref = 'system'; }
    var dark = pref === 'dark' || (pref === 'system' && systemPrefersDark());
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme-pref', pref);
  }

  function setTheme(pref) {
    applyTheme(pref);
    writeStore(STORAGE_KEYS.theme, pref);
    if (els.themeSelect) { els.themeSelect.value = pref; }
  }

  function initTheme() {
    var pref = readStore(STORAGE_KEYS.theme) || 'system';
    if (['light', 'dark', 'system'].indexOf(pref) === -1) { pref = 'system'; }
    applyTheme(pref);
    if (els.themeSelect) { els.themeSelect.value = pref; }
    try {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () {
        if (document.documentElement.getAttribute('data-theme-pref') === 'system') { applyTheme('system'); }
      };
      if (mq.addEventListener) { mq.addEventListener('change', onChange); }
      else if (mq.addListener) { mq.addListener(onChange); }
    } catch (e) { /* matchMedia unsupported */ }
  }

  /* --------------------------------------------------------------- 6 network */

  function updateNetworkLabel() {
    if (!els.netStatus || !els.netStatusText) { return; }
    els.netStatusText.textContent = state.online ? t('status.online') : t('status.offline');
    els.netStatus.classList.toggle('is-offline', !state.online);
    els.netStatus.classList.toggle('is-online', state.online);
  }

  function handleConnectionChange(isOnline) {
    if (state.online === isOnline) { return; }
    state.online = isOnline;
    updateNetworkLabel();
    showToast(isOnline ? t('toast.online') : t('toast.offline'));
  }

  function initNetwork() {
    state.online = navigator.onLine !== false;
    updateNetworkLabel();
    window.addEventListener('online', function () { handleConnectionChange(true); });
    window.addEventListener('offline', function () { handleConnectionChange(false); });
  }

  /* ------------------------------------------------------------------ 7 data */

  function fetchJSON(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) { throw new Error('HTTP ' + res.status + ' for ' + url); }
      return res.json();
    });
  }

  function asText(value) {
    return typeof value === 'string' ? value : '';
  }

  function asId(value) {
    if (typeof value === 'string') { return value.trim(); }
    if (typeof value === 'number' && isFinite(value)) { return String(value); }
    return '';
  }

  /* Turns whatever is in a JSON file into a clean article, or null. */
  function normaliseArticle(raw, slug) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return null; }
    var id = asId(raw.id);
    var title = asText(raw.title).trim();
    if (!id || !title) { return null; }
    var description = asText(raw.description).trim();
    var content = asText(raw.content).trim();
    var image = asText(raw.image).trim();
    if (!/^https?:\/\//i.test(image)) { image = ''; }
    return {
      id: id,
      title: title,
      description: description,
      content: content,
      image: image,
      category: slug,
      searchTitle: fold(title),
      searchDescription: fold(description),
      searchContent: fold(content)
    };
  }

  function ingestCategory(slug, payload) {
    var list = [];
    state.byCategory[slug] = list;
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.articles)) {
      return false;
    }
    for (var i = 0; i < payload.articles.length; i++) {
      var article = normaliseArticle(payload.articles[i], slug);
      if (!article) { continue; }
      if (state.byId.has(article.id)) {
        console.warn('OFFPEDIA: duplicate article id "' + article.id + '" in ' + slug + '.json — keeping the first one.');
        continue;
      }
      state.byId.set(article.id, article);
      state.articles.push(article);
      list.push(article);
    }
    return true;
  }

  function loadData() {
    var requests = CATEGORIES.map(function (cat) { return fetchJSON('./' + cat.slug + '.json'); });
    return Promise.allSettled(requests).then(function (results) {
      results.forEach(function (result, index) {
        var slug = CATEGORIES[index].slug;
        if (result.status === 'fulfilled') {
          var ok = ingestCategory(slug, result.value);
          if (!ok) {
            state.failedCategories.push(slug);
            console.warn('OFFPEDIA: ' + slug + '.json has no usable "articles" array — treating it as empty.');
          }
        } else {
          state.byCategory[slug] = [];
          state.failedCategories.push(slug);
          console.warn('OFFPEDIA: could not load ' + slug + '.json — treating it as empty.', result.reason);
        }
      });
      state.loaded = true;
    });
  }

  /* ---------------------------------------------------------------- 8 search */

  /* Characters that do not decompose under NFD and need an explicit mapping. */
  var FOLD_MAP = {
    '\u0259': 'e', /* ə */
    '\u018F': 'e', /* Ə */
    '\u0131': 'i', /* ı */
    '\u00DF': 'ss',
    '\u00E6': 'ae', '\u00C6': 'ae',
    '\u0153': 'oe', '\u0152': 'oe',
    '\u00F8': 'o', '\u00D8': 'o',
    '\u0111': 'd', '\u0110': 'd',
    '\u00F0': 'd', '\u00D0': 'd',
    '\u00FE': 'th', '\u00DE': 'th',
    '\u0142': 'l', '\u0141': 'l'
  };

  /* Lower-cases and strips diacritics so "Söz" matches "soz" and "Ələt" matches "elet".
     CJK text is left intact, which still matches by substring. */
  function fold(value) {
    var text = String(value == null ? '' : value).toLowerCase();
    text = text.replace(/[\u0259\u018F\u0131\u00DF\u00E6\u00C6\u0153\u0152\u00F8\u00D8\u0111\u0110\u00F0\u00D0\u00FE\u00DE\u0142\u0141]/g,
      function (ch) { return FOLD_MAP[ch] || ch; });
    if (typeof text.normalize === 'function') {
      text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  function searchArticles(query) {
    var normalised = fold(query);
    if (!normalised) { return []; }
    var tokens = normalised.split(' ').filter(Boolean);
    var scored = [];

    for (var i = 0; i < state.articles.length; i++) {
      var article = state.articles[i];
      var score = 0;
      var matchedAll = true;

      for (var j = 0; j < tokens.length; j++) {
        var token = tokens[j];
        var best = 0;
        if (article.searchTitle.indexOf(token) !== -1) { best = FIELD_WEIGHT.title; }
        else if (article.searchDescription.indexOf(token) !== -1) { best = FIELD_WEIGHT.description; }
        else if (article.searchContent.indexOf(token) !== -1) { best = FIELD_WEIGHT.content; }
        if (!best) { matchedAll = false; break; }
        score += best;
      }
      if (!matchedAll) { continue; }

      /* Prefer whole-phrase and prefix hits in the title. */
      if (article.searchTitle === normalised) { score += 40; }
      else if (article.searchTitle.indexOf(normalised) === 0) { score += 20; }
      else if (article.searchTitle.indexOf(normalised) !== -1) { score += 10; }

      scored.push({ article: article, score: score, order: i });
    }

    scored.sort(function (a, b) {
      if (b.score !== a.score) { return b.score - a.score; }
      return a.order - b.order;
    });
    return scored.map(function (entry) { return entry.article; });
  }

  /* ----------------------------------------------------------- 9 dom helpers */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text != null) { node.textContent = text; }
    return node;
  }

  function clear(node) {
    while (node.firstChild) { node.removeChild(node.firstChild); }
  }

  function linkTo(hash, className, text) {
    var a = el('a', className, text);
    a.setAttribute('href', hash);
    return a;
  }

  function articleHash(id) { return '#/article/' + encodeURIComponent(id); }
  function categoryHash(slug) { return '#/category/' + encodeURIComponent(slug); }

  function showToast(message, actionLabel, onAction, timeoutMs) {
    if (!els.toasts) { return; }
    var toast = el('div', 'toast');
    toast.appendChild(el('span', null, message));
    if (actionLabel) {
      var btn = el('button', 'btn', actionLabel);
      btn.type = 'button';
      btn.addEventListener('click', function () {
        if (toast.parentNode) { toast.parentNode.removeChild(toast); }
        if (typeof onAction === 'function') { onAction(); }
      });
      toast.appendChild(btn);
    }
    els.toasts.appendChild(toast);
    var life = typeof timeoutMs === 'number' ? timeoutMs : 4000;
    if (life > 0) {
      window.setTimeout(function () {
        if (toast.parentNode) { toast.parentNode.removeChild(toast); }
      }, life);
    }
  }

  /* --------------------------------------------------------------- 10 images */

  function buildPlaceholder() {
    var box = el('div', 'img-placeholder');
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', t('image.unavailable'));
    box.appendChild(el('span', null, t('image.unavailable')));
    return box;
  }

  function attachImage(wrap, url, altText) {
    var img = document.createElement('img');
    img.alt = altText || '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', function () {
      clear(wrap);
      wrap.appendChild(buildPlaceholder());
    });
    img.src = url;
    wrap.appendChild(img);
  }

  /* Returns a fixed-ratio media box, so a missing or failing image never shifts
     the layout. While offline we show the placeholder straight away and only
     upgrade to the real picture if it is already in the cache — the page itself
     never touches the network. */
  function buildMedia(url, altText, extraClass) {
    var wrap = el('div', 'media' + (extraClass ? ' ' + extraClass : ''));

    if (!url) {
      wrap.appendChild(buildPlaceholder());
      return wrap;
    }

    if (!state.online) {
      wrap.appendChild(buildPlaceholder());
      if (window.caches && typeof window.caches.match === 'function') {
        window.caches.match(url, { ignoreVary: true }).then(function (hit) {
          if (hit) { clear(wrap); attachImage(wrap, url, altText); }
        })['catch'](function () { /* CacheStorage unavailable — keep the placeholder */ });
      }
      return wrap;
    }

    attachImage(wrap, url, altText);
    return wrap;
  }

  /* ---------------------------------------------------------------- 11 views */

  function renderSkeleton() {
    var wrap = el('div', 'skeleton');
    for (var i = 0; i < 10; i++) { wrap.appendChild(el('div')); }
    setView(wrap, true);
  }

  function setView(node, busy) {
    clear(els.view);
    els.view.setAttribute('aria-busy', busy ? 'true' : 'false');
    els.view.appendChild(node);
  }

  function buildStateBox(icon, title, text, actions) {
    var box = el('div', 'state');
    box.appendChild(el('span', 'state-icon', icon));
    box.appendChild(el('h2', null, title));
    if (text) { box.appendChild(el('p', null, text)); }
    if (actions && actions.length) {
      var row = el('div', 'btn-row');
      actions.forEach(function (a) { row.appendChild(a); });
      box.appendChild(row);
    }
    return box;
  }

  function buildDataNotice() {
    if (!state.failedCategories.length) { return null; }
    var names = state.failedCategories.map(categoryName).join(', ');
    var notice = el('div', 'notice');
    notice.appendChild(el('span', null, '\u26A0'));
    notice.appendChild(el('span', null, t('error.dataPartial', { categories: names })));
    return notice;
  }

  function buildArticleCard(article) {
    var card = linkTo(articleHash(article.id), 'article-card');
    card.appendChild(buildMedia(article.image, article.title));
    var body = el('div', 'body');
    body.appendChild(el('span', 'badge', categoryName(article.category)));
    body.appendChild(el('h3', null, article.title));
    if (article.description) { body.appendChild(el('p', 'desc', article.description)); }
    card.appendChild(body);
    return card;
  }

  function renderHome() {
    state.currentArticleId = null;
    var frag = document.createDocumentFragment();

    var hero = el('section', 'hero');
    var inner = el('div', 'hero-inner');
    inner.appendChild(el('h1', null, t('home.welcome')));
    inner.appendChild(el('p', null, t('home.intro')));
    var stat = el('div', 'hero-stat');
    stat.appendChild(el('span', null, '\u2299'));
    stat.appendChild(el('span', null, t('home.totalArticles', { n: state.articles.length })));
    inner.appendChild(stat);
    var row = el('div', 'btn-row');
    var randomBtn = el('button', 'btn', t('home.randomButton'));
    randomBtn.type = 'button';
    randomBtn.addEventListener('click', goRandom);
    row.appendChild(randomBtn);
    inner.appendChild(row);
    hero.appendChild(inner);
    frag.appendChild(hero);

    var notice = buildDataNotice();
    if (notice) { frag.appendChild(notice); }

    var head = el('div', 'section-head');
    head.appendChild(el('h2', null, t('home.categoriesTitle')));
    head.appendChild(el('span', 'count', t('home.totalArticles', { n: state.articles.length })));
    frag.appendChild(head);

    var grid = el('div', 'grid-categories');
    CATEGORIES.forEach(function (cat) {
      var count = (state.byCategory[cat.slug] || []).length;
      var card = linkTo(categoryHash(cat.slug), 'cat-card');
      card.appendChild(el('span', 'icon', cat.icon));
      card.appendChild(el('span', 'name', categoryName(cat.slug)));
      card.appendChild(el('span', 'count', t('category.count', { n: count })));
      grid.appendChild(card);
    });
    frag.appendChild(grid);

    setView(frag, false);
  }

  function renderCategory(slug) {
    state.currentArticleId = null;
    var known = CATEGORIES.some(function (c) { return c.slug === slug; });
    if (!known) { return renderNotFound(); }

    var list = state.byCategory[slug] || [];
    var frag = document.createDocumentFragment();

    frag.appendChild(linkTo('#/', 'back-link', '\u2190 ' + t('nav.home')));

    var head = el('div', 'section-head');
    head.appendChild(el('h2', null, categoryName(slug)));
    head.appendChild(el('span', 'count', t('category.count', { n: list.length })));
    frag.appendChild(head);

    if (!list.length) {
      frag.appendChild(buildStateBox(
        '\uD83D\uDCED',
        t('category.emptyTitle'),
        t('category.emptyText'),
        [linkTo('#/', 'btn btn-secondary', t('error.home'))]
      ));
    } else {
      var grid = el('div', 'grid-articles');
      list.forEach(function (article) { grid.appendChild(buildArticleCard(article)); });
      frag.appendChild(grid);
    }
    setView(frag, false);
  }

  function renderArticle(id) {
    var article = state.byId.get(id);
    if (!article) { return renderNotFound(); }
    state.currentArticleId = article.id;

    var frag = document.createDocumentFragment();
    frag.appendChild(linkTo(categoryHash(article.category), 'back-link',
      '\u2190 ' + categoryName(article.category)));

    var wrap = el('article', 'article');
    var header = el('header', 'article-header');
    header.appendChild(el('span', 'badge', categoryName(article.category)));
    header.appendChild(el('h1', null, article.title));
    if (article.description) { header.appendChild(el('p', 'lead', article.description)); }
    wrap.appendChild(header);

    wrap.appendChild(buildMedia(article.image, article.title, 'is-square'));

    var body = el('div', 'article-body');
    if (article.content) {
      article.content.split(/\n{2,}/).forEach(function (para) {
        var text = para.replace(/\n/g, ' ').trim();
        if (text) { body.appendChild(el('p', null, text)); }
      });
    }
    if (!body.firstChild) { body.appendChild(el('p', null, t('article.noContent'))); }
    wrap.appendChild(body);

    var actions = el('div', 'article-actions');
    var another = el('button', 'btn', t('article.another'));
    another.type = 'button';
    another.addEventListener('click', goRandom);
    actions.appendChild(another);
    actions.appendChild(linkTo(categoryHash(article.category), 'btn btn-secondary',
      t('article.more', { category: categoryName(article.category) })));
    wrap.appendChild(actions);

    frag.appendChild(wrap);
    setView(frag, false);
    window.scrollTo(0, 0);
    if (els.main && typeof els.main.focus === 'function') { els.main.focus({ preventScroll: true }); }
  }

  function renderSearch(query) {
    state.currentArticleId = null;
    var frag = document.createDocumentFragment();
    var results = searchArticles(query);

    var head = el('div', 'search-head');
    head.appendChild(el('h1', null, t('search.resultsTitle', { query: query })));
    head.appendChild(el('span', 'count', t('search.count', { n: results.length })));
    frag.appendChild(head);

    if (!results.length) {
      frag.appendChild(buildStateBox(
        '\uD83D\uDD0E',
        t('search.emptyTitle'),
        t('search.emptyText', { query: query }),
        [linkTo('#/', 'btn btn-secondary', t('error.home'))]
      ));
    } else {
      var list = el('ul', 'result-list');
      results.forEach(function (article) {
        var item = el('li');
        var link = linkTo(articleHash(article.id), 'result');
        link.appendChild(buildMedia(article.image, article.title));
        var body = el('div', 'body');
        body.appendChild(el('span', 'badge', categoryName(article.category)));
        body.appendChild(el('h3', null, article.title));
        if (article.description) { body.appendChild(el('p', 'desc', article.description)); }
        link.appendChild(body);
        item.appendChild(link);
        list.appendChild(item);
      });
      frag.appendChild(list);
    }
    setView(frag, false);
  }

  function renderNotFound() {
    state.currentArticleId = null;
    setView(buildStateBox(
      '\uD83E\uDDED',
      t('error.notFoundTitle'),
      t('error.notFoundText'),
      [linkTo('#/', 'btn', t('error.home'))]
    ), false);
  }

  function goRandom() {
    if (!state.articles.length) {
      showToast(t('empty.random'));
      return;
    }
    var pool = state.articles;
    if (pool.length > 1 && state.currentArticleId) {
      pool = pool.filter(function (a) { return a.id !== state.currentArticleId; });
    }
    var pick = pool[Math.floor(Math.random() * pool.length)];
    location.hash = articleHash(pick.id);
  }

  /* --------------------------------------------------------------- 12 router */

  function parseRoute() {
    var raw = String(location.hash || '').replace(/^#/, '');
    if (!raw || raw === '/' || raw === '') { return { name: 'home' }; }
    var path = raw.replace(/^\/+/, '');
    if (!path) { return { name: 'home' }; }
    var slash = path.indexOf('/');
    var head = slash === -1 ? path : path.slice(0, slash);
    var rest = slash === -1 ? '' : path.slice(slash + 1);
    var value = '';
    try { value = decodeURIComponent(rest); } catch (e) { value = rest; }

    if (head === 'category' && value) { return { name: 'category', slug: value }; }
    if (head === 'article' && value) { return { name: 'article', id: value }; }
    if (head === 'search') { return { name: 'search', query: value }; }
    return { name: 'notfound' };
  }

  function renderRoute() {
    if (!state.loaded) { return; }
    var route = parseRoute();

    /* Keep the search box in step with the URL. */
    if (els.searchInput) {
      var expected = route.name === 'search' ? route.query : '';
      if (document.activeElement !== els.searchInput && els.searchInput.value !== expected) {
        els.searchInput.value = expected;
      }
    }

    if (route.name === 'home') { return renderHome(); }
    if (route.name === 'category') { return renderCategory(route.slug); }
    if (route.name === 'article') { return renderArticle(route.id); }
    if (route.name === 'search') {
      if (!route.query.trim()) { return renderHome(); }
      return renderSearch(route.query);
    }
    return renderNotFound();
  }

  function navigateToSearch(query) {
    var trimmed = query.trim();
    if (!trimmed) {
      if (location.hash.indexOf('#/search/') === 0) { location.hash = '#/'; }
      return;
    }
    var target = '#/search/' + encodeURIComponent(trimmed);
    if (location.hash === target) { return; }
    /* While the user keeps typing we replace the entry instead of stacking
       one history step per keystroke. */
    if (location.hash.indexOf('#/search/') === 0 && window.history && history.replaceState) {
      try {
        history.replaceState(null, '', target);
        renderRoute();
        return;
      } catch (e) { /* file:// can reject replaceState — fall through */ }
    }
    location.hash = target;
  }

  /* ------------------------------------------------------- 13 service worker */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      if (!swWarned) { console.info('OFFPEDIA: service workers are unavailable here; running without offline cache.'); swWarned = true; }
      return;
    }
    if (location.protocol === 'file:') {
      if (!swWarned) { console.info('OFFPEDIA: service workers need http(s); skipping registration on file://.'); swWarned = true; }
      return;
    }
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js', { scope: './' }).then(function (registration) {
        if (registration.waiting && navigator.serviceWorker.controller) { offerUpdate(); }
        registration.addEventListener('updatefound', function () {
          var incoming = registration.installing;
          if (!incoming) { return; }
          incoming.addEventListener('statechange', function () {
            if (incoming.state === 'installed' && navigator.serviceWorker.controller) { offerUpdate(); }
          });
        });
      })['catch'](function (err) {
        console.warn('OFFPEDIA: service worker registration failed; the app still works online.', err);
      });
    });
  }

  var updateOffered = false;
  function offerUpdate() {
    if (updateOffered) { return; }
    updateOffered = true;
    showToast(t('toast.update'), t('toast.reload'), function () { location.reload(); }, 0);
  }

  /* ----------------------------------------------------------------- 14 init */

  function cacheElements() {
    els.view = document.getElementById('view');
    els.main = document.getElementById('main');
    els.toasts = document.getElementById('toasts');
    els.searchInput = document.getElementById('search-input');
    els.langSelect = document.getElementById('lang-select');
    els.themeSelect = document.getElementById('theme-select');
    els.netStatus = document.getElementById('net-status');
    els.netStatusText = document.getElementById('net-status-text');
    els.randomNav = document.getElementById('random-nav');
  }

  function bindEvents() {
    window.addEventListener('hashchange', renderRoute);

    if (els.searchInput) {
      els.searchInput.addEventListener('input', function () {
        var value = els.searchInput.value;
        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(function () { navigateToSearch(value); }, SEARCH_DEBOUNCE_MS);
      });
      els.searchInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          window.clearTimeout(searchTimer);
          navigateToSearch(els.searchInput.value);
        }
      });
    }
    if (els.langSelect) {
      els.langSelect.addEventListener('change', function () { setLanguage(els.langSelect.value); });
    }
    if (els.themeSelect) {
      els.themeSelect.addEventListener('change', function () { setTheme(els.themeSelect.value); });
    }
    if (els.randomNav) {
      els.randomNav.addEventListener('click', goRandom);
    }
  }

  function init() {
    cacheElements();
    initTheme();
    initNetwork();
    bindEvents();
    renderSkeleton();
    registerServiceWorker();

    var lang = detectLang();
    loadLanguageFile().then(function () {
      setLanguage(lang, { render: false });
      return loadData();
    }).then(function () {
      renderRoute();
    })['catch'](function (err) {
      console.error('OFFPEDIA: start-up failed.', err);
      state.loaded = true;
      setView(buildStateBox('\u26A0', t('data.emptyTitle'), t('data.emptyText'), []), false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
