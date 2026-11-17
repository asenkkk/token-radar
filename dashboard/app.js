// Token Radar's dashboard (radar-2). It reads window.RADAR (written beside
// dashboard/ by main.ts) and renders the ranked board, a filterable table, a
// per-protocol detail drawer with the model's own inputs and the protocol's
// farm plan, and a model sandbox that re-ranks the board live. No network:
// every byte it shows is already in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var mount = document.getElementById('board');
  var view = {
    q: '',
    category: 'all',
    chain: 'all',
    watchlistOnly: false,
    tab: 'pre-token',
    sort: 'implied',
    dir: -1,
    selected: null,
    sandbox: null,
  };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var mag = Math.abs(n);
    if (mag >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (mag >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (mag >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }

  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  // A protocol's chains as one string: the first `limit` of them (0 for all),
  // or a neutral phrase when it names none.
  function chainList(r, limit) {
    var chains = r.chains || [];
    if (chains.length === 0) return 'an unnamed chain';
    return limit ? chains.slice(0, limit).join(', ') : chains.join(', ');
  }

  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  // The model in one function: the page recomputes a row from the snapshot
  // figures and checks the number board.json carries, so the page's code and
  // the board's data are visibly the same arithmetic.
  function impliedOf(row, model) {
    var change = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, change));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    return Math.max(1, Math.round(row.tvl_usd * model.base_multiple * growthMult * maturity));
  }

  // The sandbox model: the published constants unless the reader moved a slider.
  function sandboxModel() {
    if (!view.sandbox) return DATA.model;
    return {
      base_multiple: view.sandbox.base_multiple,
      growth_weight: view.sandbox.growth_weight,
      growth_floor: DATA.model.growth_floor,
      growth_cap: DATA.model.growth_cap,
      maturity_floor: view.sandbox.maturity_floor,
      maturity_range: DATA.model.maturity_range,
      maturity_days: DATA.model.maturity_days,
      unknown_age_days: DATA.model.unknown_age_days,
    };
  }

  // The implied value the table shows: the published one, or the sandbox recompute.
  function shownImplied(row) {
    return view.sandbox ? impliedOf(row, sandboxModel()) : row.implied_value_usd;
  }

  // A small DOM builder. `h('div', {class: 'x', text: 'y'}, [kids])` makes an
  // element; keys starting with `on` are event listeners, `text` and `html`
  // set content, everything else is an attribute.
  function h(tag, attrs, kids) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v === null || v === undefined) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      }
    }
    var list = kids || [];
    for (var i = 0; i < list.length; i++) {
      var kid = list[i];
      if (kid === null || kid === undefined || kid === false) continue;
      if (Array.isArray(kid)) {
        for (var j = 0; j < kid.length; j++) {
          if (kid[j]) node.appendChild(kid[j]);
        }
      } else if (typeof kid === 'string') {
        node.appendChild(document.createTextNode(kid));
      } else {
        node.appendChild(kid);
      }
    }
    return node;
  }

  // The farm plan is the same derivation main.ts writes to board.json:
  // category, chains, TVL and age decide the action, the capital, the hold
  // and every cost and time. No name is special-cased.
  function chainOf(p) {
    return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain';
  }

  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }

  function holdFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }

  // One category family's two actions: the main deposit and a second touch.
  // The first rule whose keys appear in the lowercased category wins.
  var PLAN_RULES = [
    {
      keys: ['lend', 'cdp', 'collateral'],
      main: function (n, c, ch) { return 'Supply $' + c + ' of USDC to ' + n + ' on ' + ch + ' and borrow $25 against it, then repay the borrow within the week.'; },
      again: function (n, ch) { return 'Borrow a further $25 of USDC from ' + n + ' on ' + ch + ', hold it a day, then repay it in full.'; },
    },
    {
      keys: ['dex', 'yield', 'leveraged farm'],
      main: function (n, c, ch) { return 'Provide $' + c + ' of liquidity to ' + n + "'s main pool on " + ch + ' and keep the position open.'; },
      again: function (n, ch) { return 'Swap $25 through ' + n + "'s main pool on " + ch + ' once, using the router it publishes.'; },
    },
    {
      keys: ['bridge'],
      main: function (n, c, ch) { return 'Bridge $' + c + ' of USDC to ' + ch + ' through ' + n + ' and use the bridged funds in its app.'; },
      again: function (n, ch) { return 'Bridge $25 back through ' + n + ' to ' + ch + ' so the round trip is on record.'; },
    },
    {
      keys: ['staking', 'restak'],
      main: function (n, c, ch) { return 'Stake $' + c + " of the chain's staking asset through " + n + ' and keep the receipt.'; },
      again: function (n, ch) { return 'Compound the staking receipt once through ' + n + ' on ' + ch + ' instead of letting it sit.'; },
    },
    {
      keys: ['perpetual', 'derivative'],
      main: function (n, c, ch) { return 'Deposit $' + c + ' of USDC as margin on ' + n + ' and open one small hedge.'; },
      again: function (n, ch) { return 'Close the hedge on ' + n + ' and open a fresh one half its size on ' + ch + '.'; },
    },
    {
      keys: ['prediction'],
      main: function (n, c, ch) { return 'Fund $' + c + ' and place one market position on ' + n + '.'; },
      again: function (n, ch) { return 'Settle the first market position on ' + n + ' and open a second one with $25.'; },
    },
    {
      keys: ['curator', 'allocator', 'risk'],
      main: function (n, c, ch) { return 'Deposit $' + c + ' into a ' + n + ' vault on ' + ch + ' and keep the shares.'; },
      again: function (n, ch) { return 'Deposit $25 into a second ' + n + ' vault on ' + ch + ' so two vaults hold funds.'; },
    },
    {
      keys: ['stable'],
      main: function (n, c, ch) { return 'Mint or deposit $' + c + ' of the stable asset through ' + n + ' on ' + ch + '.'; },
      again: function (n, ch) { return 'Redeem $25 of the stable asset through ' + n + ' on ' + ch + ' and re-mint it the same day.'; },
    },
    {
      keys: ['rwa'],
      main: function (n, c, ch) { return 'Mint $' + c + " of the protocol's yield asset on " + ch + ' and hold it.'; },
      again: function (n, ch) { return 'Claim the yield distribution ' + n + ' pays on ' + ch + ' instead of leaving it unclaimed.'; },
    },
    {
      keys: ['insurance'],
      main: function (n, c, ch) { return 'Buy $' + c + ' of cover from ' + n + ' on ' + ch + ' and keep the policy.'; },
      again: function (n, ch) { return 'Review the ' + n + ' policy on ' + ch + ' and add a second $25 cover for a different risk.'; },
    },
  ];

  function ruleFor(category) {
    var c = (category || '').toLowerCase();
    for (var i = 0; i < PLAN_RULES.length; i++) {
      var rule = PLAN_RULES[i];
      for (var j = 0; j < rule.keys.length; j++) {
        if (c.indexOf(rule.keys[j]) >= 0) return rule;
      }
    }
    return null;
  }

  function crossChainStep(p, chain) {
    var second = p.chains && p.chains.length > 1 ? p.chains[1] : null;
    if (second !== null) return 'Repeat the main action with $25 on ' + second + ' so the activity spans two chains, not one.';
    return "Use " + p.name + "'s app on " + chain + ' a second way -- its swap, vote or rewards tab -- once a week.';
  }

  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }

  function farmSteps(p) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdFor(p.age_days);
    var rule = ruleFor(p.category);
    var mainAction = rule
      ? rule.main(p.name, capital, chain)
      : 'Deposit $' + capital + ' of USDC into ' + p.name + ' on ' + chain + ' and keep the position open.';
    var secondAction = rule
      ? rule.again(p.name, chain)
      : "Use " + p.name + "'s second feature on " + chain + ' -- its swap, vote or rewards tab -- once.';
    var gas = capital >= 150 ? 8 : 4;
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: mainAction, cost: '$' + capital + ' of capital and about $' + gas + ' of gas', time: '15 minutes to set up' },
      { text: secondAction, cost: '$25 of capital and about $2 of gas', time: '10 minutes' },
      { text: crossChainStep(p, chain), cost: '$25 of capital and about $3 of gas', time: '15 minutes' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote, and keep a weekly streak.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log, and unwind in two steps: withdraw half, then the rest a day later.', cost: 'about $4 of gas to unwind', time: '15 minutes to unwind' },
    ].map(stepText);
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) view.q = params.get('q');
    if (params.get('p')) view.selected = params.get('p');
    if (params.get('category')) view.category = params.get('category');
    if (params.get('chain')) view.chain = params.get('chain');
    if (params.get('wl') === '1') view.watchlistOnly = true;
  }

  function writeHash() {
    var params = new URLSearchParams();
    if (view.q) params.set('q', view.q);
    if (view.category !== 'all') params.set('category', view.category);
    if (view.chain !== 'all') params.set('chain', view.chain);
    if (view.watchlistOnly) params.set('wl', '1');
    if (view.selected) params.set('p', view.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  var watchlistSet = {};
  (DATA.watchlist || []).forEach(function (s) { watchlistSet[s] = true; });

  function visibleRows() {
    var q = view.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (view.category !== 'all' && r.category !== view.category) return false;
      if (view.chain !== 'all' && !(r.chains || []).some(function (c) { return c === view.chain; })) return false;
      if (view.watchlistOnly && !watchlistSet[r.slug]) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function sortValue(r, key) {
    if (key === 'name') return r.name.toLowerCase();
    if (key === 'tvl') return r.tvl_usd;
    if (key === 'growth') return r.change_7d === null ? -Infinity : r.change_7d;
    if (key === 'age') return r.age_days === null ? Infinity : r.age_days;
    return shownImplied(r);
  }

  function sortedRows(list) {
    var key = view.sort;
    var dir = view.dir;
    return list.slice().sort(function (a, b) {
      var av = sortValue(a, key);
      var bv = sortValue(b, key);
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function pageHeader() {
    return h('header', { class: 'top' }, [
      h('div', { class: 'brand' }, [
        h('span', { class: 'mark' }),
        h('span', { class: 'brand-name', text: 'Token Radar' }),
      ]),
      h('div', { class: 'top-meta' }, [
        h('span', { text: 'Snapshot ' + DATA.as_of }),
        h('span', { text: 'DefiLlama protocol index' }),
        h('span', { text: DATA.model_version + ' model' }),
      ]),
    ]);
  }

  function pageLede() {
    return h('section', { class: 'lede' }, [
      h('div', null, [
        h('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        h('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor, every one of them. Implied value is a model, not a promise.' }),
      ]),
      h('div', { class: 'facts' }, [
        h('div', { class: 'fact' }, [h('span', { text: 'Watchlist covered' }), h('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })]),
        h('div', { class: 'fact' }, [h('span', { text: 'Pre-token rows scored' }), h('b', { text: String(DATA.board_size) })]),
        h('div', { class: 'fact' }, [h('span', { text: 'Early rows below the floor' }), h('b', { text: String(DATA.early_size) })]),
        h('div', { class: 'fact' }, [h('span', { text: 'Live-token protocols set aside' }), h('b', { text: String(DATA.live_size) })]),
      ]),
    ]);
  }

  function pageControls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = h('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: view.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { view.q = search.value; writeHash(); render(); });
    var catSel = h('select', { id: 'category', 'aria-label': 'Filter by category' }, [
      h('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return h('option', { value: c, text: c, selected: c === view.category ? 'selected' : null }); }),
    ]);
    catSel.addEventListener('change', function () { view.category = catSel.value; writeHash(); render(); });
    var chainSel = h('select', { id: 'chain', 'aria-label': 'Filter by chain' }, [
      h('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return h('option', { value: c, text: c, selected: c === view.chain ? 'selected' : null }); }),
    ]);
    chainSel.addEventListener('change', function () { view.chain = chainSel.value; writeHash(); render(); });
    var wl = h('button', { type: 'button', 'aria-pressed': view.watchlistOnly ? 'true' : 'false', text: 'Watchlist only', onclick: function () { view.watchlistOnly = !view.watchlistOnly; writeHash(); render(); } });
    var pre = h('button', { type: 'button', 'aria-pressed': view.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { view.tab = 'pre-token'; render(); } });
    var live = h('button', { type: 'button', 'aria-pressed': view.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { view.tab = 'live'; render(); } });
    return h('div', { class: 'controls' }, [
      h('div', { class: 'field' }, [h('label', { for: 'q', text: 'Search' }), search]),
      h('div', { class: 'field' }, [h('label', { for: 'category', text: 'Category' }), catSel]),
      h('div', { class: 'field' }, [h('label', { for: 'chain', text: 'Chain' }), chainSel]),
      h('div', { class: 'field' }, [h('span', { class: 'sub', text: 'Watchlist' }), wl]),
      h('div', { class: 'field' }, [h('span', { class: 'sub', text: 'Token status' }), h('div', { class: 'tabs' }, [pre, live])]),
      h('span', { class: 'count', text: view.tab === 'pre-token' ? visibleRows().length + ' rows shown' : DATA.live.length + ' live-token protocols' }),
    ]);
  }

  function sandboxStrip() {
    var m = DATA.model;
    function slider(key, label, min, max, step, value) {
      var out = h('output', { text: String(value) });
      var input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label });
      input.addEventListener('input', function () {
        if (!view.sandbox) view.sandbox = { base_multiple: m.base_multiple, growth_weight: m.growth_weight, maturity_floor: m.maturity_floor };
        view.sandbox[key] = parseFloat(input.value);
        out.textContent = input.value;
        render();
      });
      return h('div', { class: 'slider' }, [h('label', { text: label }), input, out]);
    }
    var reset = h('button', { class: 'button', type: 'button', text: 'Reset to published model', onclick: function () { view.sandbox = null; render(); } });
    var note = h('span', { class: 'sub', text: view.sandbox ? 'Sandbox: the board below is re-ranked with your constants. board.json keeps the published ranking.' : 'Try the model: move a constant and the board re-ranks. board.json keeps the published ranking.' });
    return h('section', { class: 'sandbox' }, [
      h('div', { class: 'sandbox-head' }, [h('h2', { text: 'Model sandbox' }), note]),
      h('div', { class: 'sliders' }, [
        slider('base_multiple', 'Base multiple', 0.05, 0.5, 0.01, view.sandbox ? view.sandbox.base_multiple : m.base_multiple),
        slider('growth_weight', 'Growth weight', 0, 1, 0.05, view.sandbox ? view.sandbox.growth_weight : m.growth_weight),
        slider('maturity_floor', 'Maturity floor', 0.3, 0.8, 0.05, view.sandbox ? view.sandbox.maturity_floor : m.maturity_floor),
        reset,
      ]),
    ]);
  }

  function sortHead(key, label) {
    return h('th', { scope: 'col' }, [
      h('button', { type: 'button', onclick: function () { if (view.sort === key) view.dir = -view.dir; else { view.sort = key; view.dir = -1; } render(); } }, [
        label,
        view.sort === key ? h('span', { 'aria-hidden': 'true', text: view.dir < 0 ? ' v' : ' ^' }) : null,
      ]),
    ]);
  }

  function boardTable() {
    var list = sortedRows(visibleRows());
    if (list.length === 0) {
      return h('div', { class: 'panel' }, [
        h('div', { class: 'empty' }, [
          h('h2', { text: 'No protocol matches that filter' }),
          h('p', { text: 'Clear the search or pick another category to see the board again.' }),
          h('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { view.q = ''; view.category = 'all'; view.chain = 'all'; view.watchlistOnly = false; writeHash(); render(); } }),
        ]),
      ]);
    }
    var max = list.reduce(function (a, r) { return Math.max(a, shownImplied(r)); }, 1);
    var tbody = h('tbody');
    list.forEach(function (r, i) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var shownRank = view.sort === 'implied' && view.dir < 0 ? i + 1 : r.rank;
      var tr = h('tr', {
        'data-selected': view.selected === r.slug ? 'true' : 'false',
        'data-top': r.rank <= 3 ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } },
      }, [
        h('td', { class: 'num rank', text: String(shownRank) }),
        h('td', null, [h('div', { class: 'name' }, [
          h('b', { text: r.name }),
          h('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + chainList(r, 2) + (watchlistSet[r.slug] ? ' - watchlist' : '') }),
        ])]),
        h('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        h('td', { class: 'num ' + growthClass, text: growth }),
        h('td', { class: 'num', text: fmtAge(r.age_days) }),
        h('td', null, [h('div', { class: 'implied' }, [
          h('div', { class: 'bar', 'aria-hidden': 'true' }, [h('i', { style: 'width:' + Math.max(3, Math.round((shownImplied(r) / max) * 100)) + '%' })]),
          h('span', { class: 'num', text: fmtUsd(shownImplied(r)) }),
        ])]),
        h('td', null, [h('span', { class: 'status', text: 'no token' })]),
      ]);
      tbody.appendChild(tr);
    });
    return h('div', { class: 'panel' }, [
      h('div', { class: 'table-wrap' }, [
        h('table', null, [
          h('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          h('thead', null, [h('tr', null, [
            sortHead('implied', 'Rank'),
            sortHead('name', 'Protocol'),
            sortHead('tvl', 'TVL'),
            sortHead('growth', '7d'),
            sortHead('age', 'Age'),
            sortHead('implied', 'Implied value'),
            h('th', { scope: 'col', text: 'Token' }),
          ])]),
          tbody,
        ]),
      ]),
    ]);
  }

  function liveTable() {
    var tbody = h('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(h('tr', null, [
        h('td', { class: 'num', text: 'live' }),
        h('td', null, [h('div', { class: 'name' }, [h('b', { text: r.name }), h('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + chainList(r, 2) })])]),
        h('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        h('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        h('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        h('td', null, [h('span', { class: 'status live', text: 'already trades' })]),
      ]));
    });
    return h('div', { class: 'panel' }, [
      h('div', { class: 'table-wrap' }, [
        h('table', null, [
          h('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          h('thead', null, [h('tr', null, [h('th', { scope: 'col', text: 'Status' }), h('th', { scope: 'col', text: 'Protocol' }), h('th', { scope: 'col', text: 'TVL' }), h('th', { scope: 'col', text: '7d' }), h('th', { scope: 'col', text: 'Market cap' }), h('th', { scope: 'col', text: 'Token' })])]),
          tbody,
        ]),
      ]),
    ]);
  }

  function modelPanel() {
    var m = DATA.model;
    return h('section', { class: 'panel model' }, [
      h('h2', { text: 'How implied value is computed' }),
      h('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      h('div', { class: 'formula' }, [
        'implied = round( tvl_usd x ' + m.base_multiple + ' x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') )',
      ]),
      h('p', { class: 'sub', text: 'A token is worth a fraction of the value its protocol secures, so the base multiple is 0.25: a $1B protocol implies a $250M token before growth and age. Growth is capped so one hot week cannot triple a protocol, and maturity is capped at three years so age alone cannot double one. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + m.unknown_age_days + ' days, and an unreported seven-day change counts as zero growth. The early radar is every pre-token protocol below the watchlist floor, by TVL, and the live-token protocols are set aside with their market caps shown.' }),
    ]);
  }

  var dialog = h('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { view.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    view.selected = slug;
    writeHash();
    dialog.textContent = '';
    var steps = farmSteps(row);
    var recomputed = impliedOf(row, DATA.model);
    var sandboxNote = view.sandbox ? h('p', { class: 'sub', text: 'Sandbox: with your constants this row implies ' + fmtUsd(shownImplied(row)) + ', against a published ' + fmtUsd(row.implied_value_usd) + '.' }) : null;
    dialog.appendChild(h('div', { class: 'detail-head' }, [
      h('div', null, [
        h('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (watchlistSet[row.slug] ? ' - watchlist' : '') }),
        h('h2', { id: 'detail-title', text: row.name }),
        h('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + chainList(row, 0) + ' - listed ' + (row.listed_at || 'unknown') }),
      ]),
      h('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } }),
    ]));
    dialog.appendChild(h('section', { class: 'detail-section' }, [
      h('h3', { text: 'Implied value' }),
      h('div', { class: 'equation' }, [
        h('div', null, [h('span', { text: 'TVL' }), h('b', { class: 'num', text: fmtUsd(row.tvl_usd) })]),
        h('div', null, [h('span', { text: 'Seven-day growth' }), h('b', { class: 'num', text: fmtPct(row.change_7d) })]),
        h('div', null, [h('span', { text: 'Age with no token' }), h('b', { class: 'num', text: fmtAge(row.age_days) })]),
        h('div', null, [h('span', { text: 'Growth multiplier' }), h('b', { class: 'num', text: String(row.growth_multiplier) })]),
        h('div', null, [h('span', { text: 'Maturity multiplier' }), h('b', { class: 'num', text: String(row.maturity_multiplier) })]),
        h('div', null, [h('span', { text: 'Implied value' }), h('b', { class: 'num', text: fmtUsd(row.implied_value_usd) })]),
      ]),
      h('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtUsd(recomputed) + (recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' }),
      sandboxNote,
    ]));
    dialog.appendChild(h('section', { class: 'detail-section' }, [
      h('h3', { text: 'Farm plan' }),
      h('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return h('li', null, [h('b', { text: action }), h('span', { class: 'cost', text: tail })]);
      })),
    ]));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    mount.textContent = '';
    var shell = h('div', { class: 'shell' });
    shell.appendChild(pageHeader());
    shell.appendChild(pageLede());
    shell.appendChild(pageControls());
    shell.appendChild(sandboxStrip());
    shell.appendChild(view.tab === 'pre-token' ? boardTable() : liveTable());
    if (view.tab === 'pre-token') shell.appendChild(modelPanel());
    mount.appendChild(shell);
    mount.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) mount.appendChild(dialog);
    if (view.selected) openDetail(view.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
