(function () {
  'use strict';

  const C = window.Converter;

  const CBR_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';
  const FALLBACK_URL = 'https://open.er-api.com/v6/latest/USD';
  const POPULAR = ['RUB', 'USD', 'EUR', 'CNY', 'GBP', 'TRY', 'KZT', 'AED', 'JPY', 'CHF'];
  const QUICK_PAIRS = [['USD', 'RUB'], ['EUR', 'RUB'], ['CNY', 'RUB'], ['RUB', 'USD'], ['RUB', 'EUR']];
  const HISTORY_DAYS = 14;
  const HISTORY_LIMIT = 6;

  const $ = (sel) => document.querySelector(sel);
  const el = {
    amount: $('#amount'), amountError: $('#amount-error'),
    from: $('#from'), to: $('#to'), swap: $('#swap'),
    chips: $('#chips'),
    resultFrom: $('#result-from'), result: $('#result'), rate: $('#rate'),
    status: $('#status'),
    chart: $('#chart'), chartCaption: $('#chart-caption'), delta: $('#delta'), readout: $('#chart-readout'),
    history: $('#history'), historyEmpty: $('#history-empty'), clear: $('#clear'),
    theme: $('#theme'),
  };

  const state = {
    data: null,        // актуальные курсы в внутреннем формате
    days: [],          // курсы по дням (от новых к старым) для графика
    historyToken: 0,   // защита от гонок при загрузке истории
  };

  /* ---------- localStorage с защитой от ошибок (приватный режим и т.п.) ---------- */
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    },
  };

  /* ---------- сеть ---------- */
  async function fetchJson(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** ЦБ -> запасной API -> кэш из localStorage. */
  async function loadRates() {
    try {
      const data = C.parseCbr(await fetchJson(CBR_URL));
      store.set('rates', data);
      return { data, stale: false };
    } catch (e) { /* пробуем дальше */ }

    try {
      const data = C.parseErApi(await fetchJson(FALLBACK_URL));
      store.set('rates', data);
      return { data, stale: false };
    } catch (e) { /* пробуем кэш */ }

    const cached = store.get('rates', null);
    if (cached && cached.rates) return { data: cached, stale: true };
    throw new Error('Курсы недоступны');
  }

  /* ---------- селекты ---------- */
  function fillSelects(rates) {
    const { popular, rest } = C.sortCodes(Object.keys(rates), POPULAR);
    for (const select of [el.from, el.to]) {
      select.textContent = '';
      select.append(group('Популярные', popular, rates), group('Все валюты', rest, rates));
    }
  }

  function group(label, codes, rates) {
    const g = document.createElement('optgroup');
    g.label = label;
    for (const code of codes) {
      const o = document.createElement('option');
      o.value = code;
      o.textContent = code + ' ' + rates[code].name;
      g.append(o);
    }
    return g;
  }

  /* ---------- вычисления и вывод ---------- */
  function update() {
    if (!state.data) return;
    const rates = state.data.rates;
    const from = el.from.value;
    const to = el.to.value;
    const amount = C.parseAmount(el.amount.value);

    renderChips();
    renderRate(from, to, rates);

    if (Number.isNaN(amount)) {
      const empty = el.amount.value.trim() === '';
      el.amountError.textContent = empty ? 'Введите сумму' : 'Введите число, например 1 000,50';
      el.amountError.hidden = false;
      el.amount.setAttribute('aria-invalid', 'true');
      el.result.textContent = '—';
      el.resultFrom.innerHTML = '&nbsp;';
      return;
    }

    el.amountError.hidden = true;
    el.amount.removeAttribute('aria-invalid');
    const value = C.convert(amount, from, to, rates);
    el.resultFrom.textContent = C.formatNumber(amount) + ' ' + from + ' =';
    el.result.textContent = C.formatNumber(value);
    scheduleHistorySave(amount, from, to, value);
  }

  function renderRate(from, to, rates) {
    const r = C.pairRate(from, to, rates);
    const back = C.pairRate(to, from, rates);
    el.rate.textContent = '1 ' + from + ' = ' + C.formatNumber(r) + ' ' + to + '\n1 ' + to + ' = ' + C.formatNumber(back) + ' ' + from;
  }

  function renderChips() {
    el.chips.textContent = '';
    for (const [a, b] of QUICK_PAIRS) {
      if (!state.data.rates[a] || !state.data.rates[b]) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.textContent = a + ' → ' + b;
      btn.setAttribute('aria-pressed', String(el.from.value === a && el.to.value === b));
      btn.addEventListener('click', () => {
        el.from.value = a;
        el.to.value = b;
        onPairChange();
      });
      el.chips.append(btn);
    }
  }

  function setStatus(text, kind) {
    el.status.textContent = text;
    if (kind) el.status.dataset.kind = kind; else delete el.status.dataset.kind;
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s?г\.$/, '');
  }

  /* ---------- график ---------- */
  async function loadHistory() {
    const token = ++state.historyToken;
    state.days = [state.data];
    state.historyLoading = Boolean(state.data.previousUrl);
    renderChart();
    let url = state.data.previousUrl;
    while (url && state.days.length < HISTORY_DAYS) {
      try {
        const day = C.parseCbr(await fetchJson(url, 6000));
        if (token !== state.historyToken) return;
        state.days.push(day);
        url = day.previousUrl;
        renderChart();
      } catch (e) {
        break; // показываем то, что успели загрузить
      }
    }
    state.historyLoading = false;
    renderChart();
  }

  function renderChart() {
    const from = el.from.value;
    const to = el.to.value;
    const points = state.days
      .filter((d) => d.rates[from] && d.rates[to])
      .map((d) => ({ date: d.date, value: C.pairRate(from, to, d.rates) }))
      .reverse();

    el.delta.hidden = true;
    el.readout.textContent = '';
    el.chart.onpointermove = el.chart.onpointerleave = null;
    if (points.length < 2) {
      el.chart.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'chart-empty';
      if (state.historyLoading) p.textContent = 'Загружаем историю…';
      else if (!state.data.previousUrl) p.textContent = 'История доступна только для курсов ЦБ РФ';
      else p.textContent = 'Недостаточно данных для графика';
      el.chart.append(p);
      return;
    }

    // ширина viewBox равна реальной ширине блока, поэтому подписи не масштабируются
    const W = Math.max(260, Math.round(el.chart.clientWidth) || 420), H = 160, padX = 8, padTop = 18, padBottom = 24;
    const values = points.map((p) => p.value);
    let min = Math.min(...values), max = Math.max(...values);
    if (min === max) { min -= min * 0.01 || 1; max += max * 0.01 || 1; }
    const x = (i) => padX + (i * (W - padX * 2)) / (points.length - 1);
    const y = (v) => padTop + ((max - v) / (max - min)) * (H - padTop - padBottom);

    const line = points.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.value).toFixed(1)).join(' ');
    const area = line + ' L' + x(points.length - 1).toFixed(1) + ' ' + (H - padBottom) + ' L' + x(0).toFixed(1) + ' ' + (H - padBottom) + ' Z';
    const last = points[points.length - 1];
    const first = points[0];
    const shortDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('aria-hidden', 'true');
    const add = (tag, attrs, text) => {
      const n = document.createElementNS(svgNS, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      if (text) n.textContent = text;
      svg.append(n);
      return n;
    };
    const defs = add('defs', {});
    const grad = document.createElementNS(svgNS, 'linearGradient');
    grad.setAttribute('id', 'area-grad');
    grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0'); grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
    for (const [offset, opacity] of [['0', '0.28'], ['1', '0']]) {
      const stop = document.createElementNS(svgNS, 'stop');
      stop.setAttribute('offset', offset);
      stop.setAttribute('style', 'stop-color: var(--chart); stop-opacity: ' + opacity);
      grad.append(stop);
    }
    defs.append(grad);

    add('path', { d: area, class: 'area' });
    add('path', { d: line, class: 'line' });
    add('circle', { cx: x(points.length - 1), cy: y(last.value), r: 4.5, class: 'dot' });
    const cursor = add('line', { x1: 0, x2: 0, y1: padTop - 4, y2: H - padBottom, class: 'cursor' });
    const cursorDot = add('circle', { cx: 0, cy: 0, r: 5, class: 'cursor-dot' });
    add('text', { x: padX, y: H - 4, class: 'lbl' }, shortDate(first.date));
    add('text', { x: W - padX, y: H - 4, class: 'lbl', 'text-anchor': 'end' }, shortDate(last.date));
    add('text', { x: padX, y: 10, class: 'lbl' }, 'макс ' + C.formatNumber(Math.max(...values)));
    add('text', { x: W - padX, y: 10, class: 'lbl', 'text-anchor': 'end' }, 'мин ' + C.formatNumber(Math.min(...values)));
    el.chart.textContent = '';
    el.chart.append(svg);

    // значение под курсором; без наведения показываем последнее
    const show = (i, active) => {
      const p = points[i];
      el.readout.textContent = shortDate(p.date) + ': ' + C.formatNumber(p.value) + ' ' + to;
      cursor.setAttribute('x1', x(i)); cursor.setAttribute('x2', x(i));
      cursorDot.setAttribute('cx', x(i)); cursorDot.setAttribute('cy', y(p.value));
      cursor.style.opacity = cursorDot.style.opacity = active ? 1 : 0;
    };
    show(points.length - 1, false);
    el.chart.onpointermove = (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const i = Math.round(((px - padX) / (W - padX * 2)) * (points.length - 1));
      show(Math.max(0, Math.min(points.length - 1, i)), true);
    };
    el.chart.onpointerleave = () => show(points.length - 1, false);
    el.chart.setAttribute('aria-label',
      'График курса ' + from + ' к ' + to + ' с ' + shortDate(first.date) + ' по ' + shortDate(last.date) +
      ': от ' + C.formatNumber(first.value) + ' до ' + C.formatNumber(last.value));

    const change = C.percentChange(last.value, first.value);
    el.delta.hidden = false;
    el.delta.className = 'delta ' + (change >= 0 ? 'up' : 'down');
    el.delta.textContent = (change >= 0 ? '+' : '−') + Math.abs(change).toFixed(2).replace('.', ',') + '%';
    el.chartCaption.textContent = from + ' → ' + to + ', за ' + points.length + ' ' + plural(points.length, ['день', 'дня', 'дней']) + ' (рабочие дни ЦБ)';
  }

  function plural(n, forms) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return forms[0];
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return forms[1];
    return forms[2];
  }

  /* ---------- история конвертаций ---------- */
  let saveTimer = null;

  function scheduleHistorySave(amount, from, to, value) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const list = store.get('history', []);
      const entry = { amount, from, to, value };
      const top = list[0];
      if (top && top.amount === amount && top.from === from && top.to === to) return;
      list.unshift(entry);
      store.set('history', list.slice(0, HISTORY_LIMIT));
      renderHistory();
    }, 1500);
  }

  function renderHistory() {
    const list = store.get('history', []);
    el.history.textContent = '';
    el.historyEmpty.hidden = list.length > 0;
    el.clear.hidden = list.length === 0;
    for (const item of list) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      const left = document.createElement('span');
      left.textContent = C.formatNumber(item.amount) + ' ' + item.from;
      const right = document.createElement('span');
      right.className = 'to';
      right.textContent = '→ ' + C.formatNumber(item.value) + ' ' + item.to;
      btn.append(left, right);
      btn.setAttribute('aria-label', 'Повторить: ' + left.textContent + ' в ' + item.to);
      btn.addEventListener('click', () => {
        if (!state.data || !state.data.rates[item.from] || !state.data.rates[item.to]) return;
        el.amount.value = String(item.amount).replace('.', ',');
        el.from.value = item.from;
        el.to.value = item.to;
        onPairChange();
      });
      li.append(btn);
      el.history.append(li);
    }
  }

  /* ---------- события ---------- */
  function onPairChange() {
    store.set('pair', { from: el.from.value, to: el.to.value });
    update();
    renderChart();
  }

  el.amount.addEventListener('input', update);
  el.from.addEventListener('change', onPairChange);
  el.to.addEventListener('change', onPairChange);

  el.swap.addEventListener('click', () => {
    const a = el.from.value;
    el.from.value = el.to.value;
    el.to.value = a;
    el.swap.classList.toggle('spin');
    onPairChange();
  });

  el.clear.addEventListener('click', () => {
    store.set('history', []);
    renderHistory();
  });

  document.getElementById('form').addEventListener('submit', (e) => e.preventDefault());

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.data) renderChart(); }, 150);
  });

  /* ---------- тема ---------- */
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0b1310' : '#eef0e8');
  }

  const savedTheme = store.get('theme', null);
  applyTheme(savedTheme || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

  el.theme.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    store.set('theme', next);
  });

  /* ---------- старт ---------- */
  async function init() {
    renderHistory();
    el.result.classList.add('skeleton');
    try {
      const { data, stale } = await loadRates();
      state.data = data;
      fillSelects(data.rates);

      const pair = store.get('pair', { from: 'USD', to: 'RUB' });
      el.from.value = data.rates[pair.from] ? pair.from : 'USD';
      el.to.value = data.rates[pair.to] ? pair.to : 'RUB';

      el.result.classList.remove('skeleton');
      update();
      renderChart();

      const date = formatDate(data.date);
      if (stale) {
        setStatus('Нет соединения: показаны сохранённые курсы' + (date ? ' на ' + date : '') + '.', 'warn');
      } else {
        setStatus('Источник: ' + data.source + (date ? ', курс на ' + date : '') + '.');
      }
      if (!stale) loadHistory();
    } catch (e) {
      el.result.classList.remove('skeleton');
      el.result.textContent = '—';
      setStatus('Не удалось загрузить курсы. Проверьте соединение и обновите страницу.', 'warn');
      el.chart.textContent = '';
    }
  }

  init();
})();
