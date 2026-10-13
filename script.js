/* Listverdict
   Everything runs in the visitor's browser. There is no server: tests are saved
   in this browser's storage (localStorage) on the visitor's own device. */

(function () {
  'use strict';

  /* ================================================================
     SETTINGS YOU CAN CHANGE
     ================================================================ */
  const CONFIG = {
    // Kit form address. In Kit, open your form, choose Publish, then the HTML option,
    // and copy the web address inside action="...". It looks like:
    // https://app.kit.com/forms/1234567/subscriptions
    // While this is empty, the email box still appears but nothing is sent to Kit.
    kitFormAction: 'https://app.kit.com/forms/10037836/subscriptions',

    // Name of a custom field in Kit that records whether someone ticked
    // "Email me tips and Listverdict updates". Create a custom field with this exact
    // name in Kit (Subscribers, then Custom fields). It will hold "yes" or "no".
    kitConsentField: 'updates_consent',

    // Your Ko-fi page, for example https://ko-fi.com/yourname
    // Leave it empty to hide the "buy me a coffee" line.
    kofiUrl: '',
  };

  // Etsy limits and verdict rules
  const RULES = {
    titleMax: 140,     // Etsy's title limit, in characters
    tagMax: 13,        // Etsy allows 13 tags
    tagLength: 20,     // and 20 characters per tag
    descPreview: 160,  // roughly how much of a description shows in search previews
    beforeDays: 14,    // the "before" period
    testDays: 14,      // recommended test length
    minDays: 3,        // earliest a verdict can be given
    minViews: 50,      // fewer listing views than this before the change = not enough data
    keepPoints: 5,     // points needed for Keep (or Undo, below zero)
    meterRange: 30,    // points shown at each end of the meter
  };

  const STORE_KEY = 'listverdict.v1';
  const DAY = 86400000;

  /* ================================================================
     SMALL HELPERS
     ================================================================ */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function esc(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function plural(n, one, many) { return n === 1 ? one : many; }

  function signed(n, suffix) {
    const r = Math.round(n);
    if (r === 0) return '0' + (suffix || '');
    return (r > 0 ? '+' : '−') + Math.abs(r) + (suffix || '');
  }

  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function daysSince(iso) { return Math.max(0, Math.round((startOfDay(new Date()) - startOfDay(new Date(iso))) / DAY)); }
  function addDays(iso, n) { const d = new Date(iso); d.setDate(d.getDate() + n); return d; }
  function niceDate(d) { return new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'long' }); }

  function makeId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  let toastTimer = null;
  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-on'), 2600);
  }

  function copyText(text, label) {
    const done = () => toast(label ? label + ' copied' : 'Copied');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }
  function fallbackCopy(text, done) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('Copy didn’t work. Select the text and copy it yourself.'); }
    area.remove();
  }

  /* ================================================================
     STORAGE (this browser only)
     ================================================================ */
  function isNum(n) { return typeof n === 'number' && isFinite(n) && n >= 0; }
  function isVersion(v) { return v && typeof v.title === 'string' && Array.isArray(v.tags); }
  function isValidTest(t) {
    return t && typeof t.id === 'string' && typeof t.name === 'string' &&
      isVersion(t.old) && isVersion(t.new) && typeof t.startedAt === 'string' &&
      !isNaN(new Date(t.startedAt)) && t.before && isNum(t.before.listing) && isNum(t.before.shop);
  }

  const store = {
    data: { unlocked: false, tests: [] },
    available: true,
    load() {
      try {
        const raw = localStorage.getItem(STORE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (saved && typeof saved === 'object') {
          this.data.unlocked = saved.unlocked === true;
          this.data.tests = Array.isArray(saved.tests) ? saved.tests.filter(isValidTest) : [];
        }
      } catch (e) {
        this.available = false;
      }
    },
    save() {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(this.data));
        return true;
      } catch (e) {
        this.available = false;
        toast('This browser isn’t letting us save. Download a backup to keep your tests.');
        return false;
      }
    },
  };

  /* ================================================================
     TAG CHIP EDITOR
     ================================================================ */
  function createChipEditor(container, onChange) {
    let tags = [];
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'chip-input';
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('aria-label', 'Add a tag');
    input.placeholder = 'Add a tag';
    container.appendChild(input);

    const changed = () => { if (onChange) onChange(); };

    function render() {
      $$('.chip', container).forEach((c) => c.remove());
      tags.forEach((tag, i) => {
        const chip = document.createElement('span');
        chip.className = 'chip' + (tag.length > RULES.tagLength ? ' is-long' : '');
        const text = document.createElement('span');
        text.className = 'chip-text';
        text.textContent = tag;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'chip-x';
        remove.textContent = '×';
        remove.setAttribute('aria-label', 'Remove tag ' + tag);
        remove.addEventListener('click', () => {
          tags.splice(i, 1);
          render();
          changed();
          input.focus();
        });
        chip.append(text, remove);
        container.insertBefore(chip, input);
      });
      input.placeholder = tags.length ? '' : 'Add a tag';
    }

    function addFrom(text) {
      const parts = text.split(/[,\n\t]/).map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
      if (!parts.length) return;
      tags = tags.concat(parts);
      render();
      changed();
    }

    function flush() {
      if (input.value.trim()) { addFrom(input.value); }
      input.value = '';
    }

    container.addEventListener('click', (e) => { if (e.target === container) input.focus(); });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        flush();
      } else if (e.key === 'Backspace' && !input.value && tags.length) {
        tags.pop();
        render();
        changed();
      }
    });

    // Handles commas typed on phone keyboards and lists pasted in one go
    input.addEventListener('input', () => {
      const v = input.value;
      if (/[,\n\t]/.test(v)) {
        const lastSep = Math.max(v.lastIndexOf(','), v.lastIndexOf('\n'), v.lastIndexOf('\t'));
        addFrom(v.slice(0, lastSep));
        input.value = v.slice(lastSep + 1).trimStart();
      }
      changed();
    });

    input.addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (/[,\n\t]/.test(text)) {
        e.preventDefault();
        addFrom(input.value + text);
        input.value = '';
      }
    });

    // Turn leftover text into a tag when the box loses focus. The short delay stops the
    // layout from shifting under a button the visitor is in the middle of tapping.
    input.addEventListener('blur', () => { setTimeout(flush, 250); });

    return {
      get() { return tags.slice(); },
      set(list) { tags = (list || []).slice(); render(); changed(); },
      flush,
      typing() { return input.value.trim(); },
      focus() { input.focus(); },
    };
  }

  function updateCounter(el, value, max, warnAt) {
    el.textContent = value + ' / ' + max;
    el.classList.toggle('is-bad', value > max);
    el.classList.toggle('is-warn', value <= max && warnAt != null && value >= warnAt);
  }

  /* ================================================================
     LISTING CHECKER
     ================================================================ */
  const STOP_WORDS = new Set(['and', 'the', 'for', 'with', 'you', 'your', 'from', 'set', 'of', 'in', 'on', 'to', 'a', 'an', 'or', 'by', 'at', 'is', 'it', 'its', 'my']);
  const ACRONYMS = new Set(['SVG', 'PNG', 'PDF', 'JPG', 'JPEG', 'USB', 'DIY', 'USA', 'XXL', 'MP3', 'ADHD', 'LED', 'NFC', 'DXF', 'EPS', 'CNC', 'LGBTQ']);

  function wordsOf(text) {
    return (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) || []).map((w) => w.replace(/^'+|'+$/g, '')).filter(Boolean);
  }

  function analyzeListing(title, tags, desc) {
    const tips = [];
    const t = title.trim();
    const add = (level, html) => tips.push({ level, html });

    if (t) {
      const len = t.length;
      if (len > RULES.titleMax) {
        add('bad', `Your title is ${len} characters. Etsy allows up to ${RULES.titleMax}, so cut ${len - RULES.titleMax}.`);
      } else {
        add('good', `Your title fits Etsy’s ${RULES.titleMax}-character limit (${len} used).`);
      }

      const start = t.slice(0, 40).trim();
      add('tip', `Shoppers on phones see the start of your title first: <q>${esc(start)}${t.length > 40 ? '…' : ''}</q> Make sure those first words say what the item is.`);

      const counts = new Map();
      wordsOf(t).forEach((w) => {
        if (w.length > 2 && !STOP_WORDS.has(w)) counts.set(w, (counts.get(w) || 0) + 1);
      });
      const repeats = Array.from(counts.entries()).filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]).slice(0, 3);
      if (repeats.length) {
        const list = repeats.map(([w, c]) => `<q>${esc(w)}</q> ${c} times`).join(', ');
        add('warn', `Repeated ${plural(repeats.length, 'word', 'words')}: ${list}. Repeating a word uses space you could give to another search term.`);
      }

      const caps = (t.match(/\b[A-Z]{3,}\b/g) || []).filter((w) => !ACRONYMS.has(w));
      if (caps.length >= 3) {
        add('warn', `${caps.length} words are in capitals. A title in capitals can read like shouting and is harder to scan.`);
      }
    }

    const n = tags.length;
    if (n === 0) {
      if (t) add('tip', 'Add your tags to check them too.');
    } else {
      if (n > RULES.tagMax) add('bad', `You have ${n} tags. Etsy allows ${RULES.tagMax}, so remove ${n - RULES.tagMax}.`);
      else if (n < RULES.tagMax) add('warn', `You’re using ${n} of ${RULES.tagMax} tags. Each empty slot is a search you could show up in.`);
      else add('good', `All ${RULES.tagMax} tags are used.`);

      const long = tags.filter((x) => x.length > RULES.tagLength);
      if (long.length) {
        add('bad', `${long.length} ${plural(long.length, 'tag is', 'tags are')} over Etsy’s ${RULES.tagLength}-character limit: ${long.map((x) => `<q>${esc(x)}</q>`).join(', ')}.`);
      }

      const seen = new Set();
      const dupes = new Set();
      tags.forEach((x) => { const k = x.toLowerCase(); if (seen.has(k)) dupes.add(x); seen.add(k); });
      if (dupes.size) {
        add('warn', `Used twice: ${Array.from(dupes).map((x) => `<q>${esc(x)}</q>`).join(', ')}. Swap the copy for a different search phrase.`);
      }

      const single = tags.filter((x) => !/\s/.test(x)).length;
      if (n >= 4 && single > n / 2) {
        add('tip', 'Most of your tags are single words. Phrases such as <q>pastel phone wallpaper</q> match what shoppers actually type.');
      }
    }

    const d = desc.trim();
    if (d) {
      if (d.length > RULES.descPreview) {
        add('tip', `Only about the first ${RULES.descPreview} characters of a description show in search previews. Yours starts: <q>${esc(d.slice(0, RULES.descPreview).trim())}…</q>`);
      } else {
        add('good', 'Your description opening is short enough to show in full in search previews.');
      }
    }

    const order = { bad: 0, warn: 1, tip: 2, good: 3 };
    tips.sort((a, b) => order[a.level] - order[b.level]);
    return tips;
  }

  const ICONS = { bad: '!', warn: '!', tip: 'i', good: '✓' };

  function setupChecker() {
    const title = $('#check-title');
    const desc = $('#check-desc');
    const tags = createChipEditor($('[data-chips="check-tags"]'), update);

    function update() {
      updateCounter($('#check-title-count'), title.value.trim().length, RULES.titleMax, 120);
      const tagList = tags.get();
      updateCounter($('#check-tags-count'), tagList.length, RULES.tagMax);
      $('#check-desc-count').textContent = desc.value.trim().length + ' characters';

      const tips = analyzeListing(title.value, tagList, desc.value);
      const summary = $('#check-summary');
      const list = $('#check-tips');

      if (!title.value.trim() && !tagList.length && !desc.value.trim()) {
        summary.textContent = 'Paste a title to see tips';
        list.innerHTML = '';
        return;
      }

      const bad = tips.filter((x) => x.level === 'bad').length;
      const warn = tips.filter((x) => x.level === 'warn').length;
      if (bad) summary.textContent = `${bad} ${plural(bad, 'thing', 'things')} to fix` + (warn ? `, ${warn} to improve` : '');
      else if (warn) summary.textContent = `${warn} ${plural(warn, 'thing', 'things')} to improve`;
      else summary.textContent = 'Looking good';

      list.innerHTML = tips.map((tip) =>
        `<li class="tip tip-${tip.level}"><span class="tip-icon" aria-hidden="true">${ICONS[tip.level]}</span><span>${tip.html}</span></li>`
      ).join('');
    }

    title.addEventListener('input', update);
    desc.addEventListener('input', update);
    update();
  }

  /* ================================================================
     OLD vs NEW SWAP CARDS
     ================================================================ */
  function normWord(w) { return w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }

  function highlightNew(oldTitle, newTitle) {
    const oldWords = new Set(wordsOf(oldTitle).map(normWord));
    return newTitle.split(/(\s+)/).map((part) => {
      if (/^\s+$/.test(part) || !part) return part;
      const key = normWord(part);
      return key && !oldWords.has(key) ? `<mark>${esc(part)}</mark>` : esc(part);
    }).join('');
  }

  const SWAP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4L3 8l4 4"/><path d="M3 8h14"/><path d="M17 12l4 4-4 4"/><path d="M21 16H7"/></svg>';

  // copyFor: 'new', 'old' or null. Copy buttons appear on that card.
  function renderSwap(container, oldV, newV, copyFor) {
    const oldTags = new Set(oldV.tags.map((x) => x.toLowerCase()));
    const card = (kind, v) => {
      const isNew = kind === 'new';
      const titleHtml = isNew ? highlightNew(oldV.title, v.title) : esc(v.title);
      const tagsHtml = v.tags.length
        ? `<div class="swap-tags">${v.tags.map((t) => `<span class="${isNew && !oldTags.has(t.toLowerCase()) ? 'is-added' : ''}">${esc(t)}</span>`).join('')}</div>`
        : '';
      const copy = copyFor === kind
        ? `<div class="swap-copy">
             <button class="btn btn-small" type="button" data-copy="${kind}-title">Copy title</button>
             ${v.tags.length ? `<button class="btn btn-small" type="button" data-copy="${kind}-tags">Copy tags</button>` : ''}
           </div>`
        : '';
      return `<div class="swap-card is-${kind}">
          <span class="swap-label">${isNew ? 'New version' : 'Old version'}</span>
          <p class="swap-title">${titleHtml}</p>
          ${tagsHtml}
          ${copy}
        </div>`;
    };

    container.classList.add('swap');
    container.classList.remove('is-swapped');
    container.innerHTML =
      card('old', oldV) +
      `<button class="swap-btn" type="button" aria-label="Swap the two versions around" aria-pressed="false">${SWAP_ICON}</button>` +
      card('new', newV);

    const versions = { old: oldV, new: newV };
    $$('[data-copy]', container).forEach((btn) => {
      btn.addEventListener('click', () => {
        const [kind, what] = btn.dataset.copy.split('-');
        const v = versions[kind];
        if (what === 'title') copyText(v.title, 'Title');
        else copyText(v.tags.join(', '), 'Tags');
      });
    });

    const swapBtn = $('.swap-btn', container);
    swapBtn.addEventListener('click', () => {
      const on = container.classList.toggle('is-swapped');
      swapBtn.setAttribute('aria-pressed', String(on));
      container.classList.remove('is-animating');
      void container.offsetWidth; // restart the animation
      container.classList.add('is-animating');
    });
  }

  /* ================================================================
     VERDICT
     ================================================================ */
  function computeVerdict(before, after) {
    const days = after.days;
    const base = { days };
    if (before.listing < RULES.minViews) return Object.assign(base, { kind: 'data', points: 0 });

    const beforeRate = before.listing / RULES.beforeDays;
    const afterRate = after.listing / days;
    const listingPct = (afterRate - beforeRate) / beforeRate * 100;

    const restBefore = before.shop - before.listing;
    const restAfter = after.shop - after.listing;
    let shopPct = null;
    if (restBefore >= RULES.minViews) {
      const restBeforeRate = restBefore / RULES.beforeDays;
      const restAfterRate = restAfter / days;
      shopPct = (restAfterRate - restBeforeRate) / restBeforeRate * 100;
    }

    const points = Math.round(listingPct - (shopPct == null ? 0 : shopPct));
    let kind = 'close';
    if (points >= RULES.keepPoints) kind = 'keep';
    else if (points <= -RULES.keepPoints) kind = 'undo';
    return Object.assign(base, { kind, points, listingPct, shopPct });
  }

  const VERDICT_WORDS = { keep: 'Keep it', undo: 'Undo it', close: 'Too close to call', data: 'Not enough data' };
  const BADGE_WORDS = { keep: 'Keep', undo: 'Undo', close: 'Too close', data: 'No data' };

  function meterSvg() {
    return `<svg class="meter" viewBox="0 0 240 140" aria-hidden="true">
      <path class="meter-zone zone-undo" d="M20 120 A100 100 0 0 1 90.8 24.4"/>
      <path class="meter-zone zone-close" d="M97.5 22.6 A100 100 0 0 1 142.5 22.6"/>
      <path class="meter-zone zone-keep" d="M149.2 24.4 A100 100 0 0 1 220 120"/>
      <g class="needle" style="--deg: 0deg"><line x1="120" y1="120" x2="120" y2="38"/></g>
      <circle class="needle-hub" cx="120" cy="120" r="9"/>
    </svg>`;
  }

  function needleDeg(points) {
    const clamped = Math.max(-RULES.meterRange, Math.min(RULES.meterRange, points));
    return clamped / RULES.meterRange * 90;
  }

  function explainVerdict(v) {
    if (v.kind === 'data') {
      return `This listing had fewer than ${RULES.minViews} views in the ${RULES.beforeDays} days before the change. With numbers that small, a few visits either way swing the result too much to judge fairly.`;
    }
    const lp = `${signed(v.listingPct, '%')}`;
    const daily = v.days === RULES.beforeDays ? '' : ' per day';
    let why;
    if (v.shopPct == null) {
      why = `This listing’s views changed by ${lp}${daily}. The rest of your shop had too few views to compare against, so this verdict only looks at the listing itself.`;
    } else {
      why = `This listing’s views changed by ${lp}${daily}, while the rest of your shop changed by ${signed(v.shopPct, '%')}. So your change earned about ${signed(v.points)} ${plural(Math.abs(v.points), 'point', 'points')}.`;
    }
    const next = {
      keep: ' Your new version stays.',
      undo: ' Copy your old version back into Etsy below.',
      close: ` That’s within normal ups and downs. Give it another week, or keep whichever version you prefer.`,
    }[v.kind];
    return why + next;
  }

  /* ================================================================
     RESULTS DIALOG
     ================================================================ */
  const dialog = $('#results-dialog');
  const dialogBody = $('#results-body');

  function openDialog() {
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }
  function closeDialog() {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }
  // Click on the dark backdrop closes the dialog
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeDialog(); });

  function findTest(id) { return store.data.tests.find((t) => t.id === id); }

  function openResults(id) {
    const test = findTest(id);
    if (!test) return;
    const elapsed = daysSince(test.startedAt);
    const days = Math.max(1, elapsed);
    const early = elapsed < RULES.testDays;
    const prev = test.after || {};

    dialogBody.innerHTML = `
      <h2 id="results-title">Results for ${esc(test.name)}</h2>
      ${early ? `<p class="notice">It’s been ${elapsed} ${plural(elapsed, 'day', 'days')}. The verdict is fairer after ${RULES.testDays} days, but you can check now.</p>` : ''}
      <p class="step-help">In Etsy Stats, set the date range to start on the day you made the change (${esc(niceDate(test.startedAt))}) and end today. Use views for both numbers, like last time.</p>
      <form id="results-form" novalidate>
        <div class="field">
          <label class="field-label" for="res-days">Days since the change</label>
          <input class="input" id="res-days" type="number" inputmode="numeric" min="1" max="90" step="1" value="${prev.days || days}">
        </div>
        <div class="number-pair">
          <div class="field">
            <label class="field-label" for="res-listing">This listing’s views</label>
            <input class="input input-big" id="res-listing" type="number" inputmode="numeric" min="0" step="1" value="${prev.listing != null ? prev.listing : ''}">
          </div>
          <div class="field">
            <label class="field-label" for="res-shop">Whole shop’s views</label>
            <input class="input input-big" id="res-shop" type="number" inputmode="numeric" min="0" step="1" value="${prev.shop != null ? prev.shop : ''}">
          </div>
        </div>
        <p class="form-error" id="res-error" role="alert"></p>
        <div class="wizard-nav">
          <button class="btn btn-primary" type="submit">Get the verdict</button>
        </div>
      </form>`;

    openDialog();
    const firstEmpty = $('#res-listing').value ? $('#res-days') : $('#res-listing');
    firstEmpty.focus();

    $('#results-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const err = $('#res-error');
      const dVal = readWhole($('#res-days'));
      const lVal = readWhole($('#res-listing'));
      const sVal = readWhole($('#res-shop'));
      $$('#results-form .input').forEach((i) => i.classList.remove('is-invalid'));

      if (dVal == null || dVal < 1) return fail(err, $('#res-days'), 'Enter how many days it’s been since you made the change.');
      if (dVal < RULES.minDays) return fail(err, $('#res-days'), `Give the test at least ${RULES.minDays} days before checking.`);
      if (lVal == null) return fail(err, $('#res-listing'), 'Enter this listing’s views as a whole number.');
      if (sVal == null) return fail(err, $('#res-shop'), 'Enter your whole shop’s views as a whole number.');
      if (sVal < lVal) return fail(err, $('#res-shop'), 'Your shop’s views include this listing, so they can’t be lower than the listing’s.');

      test.after = { days: dVal, listing: lVal, shop: sVal };
      test.result = computeVerdict(test.before, test.after);
      test.checkedAt = new Date().toISOString();
      store.save();
      renderTests();
      showVerdict(test);
    });
  }

  function showVerdict(test) {
    const v = test.result;
    dialogBody.innerHTML = `
      <div class="verdict verdict-${v.kind}">
        <h2 id="results-title">Verdict for ${esc(test.name)}</h2>
        ${meterSvg()}
        <p class="verdict-word">${VERDICT_WORDS[v.kind]}</p>
        ${v.kind !== 'data' ? `<p class="verdict-points">${signed(v.points)} ${plural(Math.abs(v.points), 'point', 'points')}</p>` : ''}
        <p class="verdict-explain">${explainVerdict(v)}</p>
        <dl class="verdict-numbers">
          <dt>Listing, ${RULES.beforeDays} days before</dt><dd>${test.before.listing.toLocaleString()}</dd>
          <dt>Listing, ${test.after.days} ${plural(test.after.days, 'day', 'days')} after</dt><dd>${test.after.listing.toLocaleString()}</dd>
          <dt>Whole shop, before</dt><dd>${test.before.shop.toLocaleString()}</dd>
          <dt>Whole shop, after</dt><dd>${test.after.shop.toLocaleString()}</dd>
        </dl>
        ${v.kind === 'undo' ? '<div class="swap" id="verdict-swap"></div>' : ''}
        <div class="wizard-nav">
          <button class="btn btn-ghost" type="button" id="verdict-redo">Edit numbers</button>
          <button class="btn btn-primary" type="button" id="verdict-done">Done</button>
        </div>
      </div>`;

    openDialog();
    if (v.kind === 'undo') renderSwap($('#verdict-swap'), test.old, test.new, 'old');

    const needle = $('.verdict .needle', dialogBody);
    const deg = needleDeg(v.points || 0);
    requestAnimationFrame(() => requestAnimationFrame(() => { needle.style.setProperty('--deg', deg + 'deg'); }));

    $('#verdict-done').addEventListener('click', closeDialog);
    $('#verdict-redo').addEventListener('click', () => openResults(test.id));
    $('#verdict-done').focus();
  }

  function readWhole(input) {
    const raw = input.value.trim();
    if (raw === '' || !/^\d+$/.test(raw)) return null;
    return parseInt(raw, 10);
  }

  function fail(errEl, input, message) {
    errEl.textContent = message;
    if (input) { input.classList.add('is-invalid'); input.focus(); }
    return false;
  }

  /* ================================================================
     TEST WIZARD
     ================================================================ */
  function setupWizard() {
    const form = $('#wizard');
    const steps = $$('.step', form);
    const total = steps.length;
    const err = $('#wiz-error');
    const back = $('#wiz-back');
    const next = $('#wiz-next');
    let step = 1;

    const name = $('#wiz-name');
    const oldTitle = $('#wiz-old-title');
    const newTitle = $('#wiz-new-title');
    const beforeListing = $('#wiz-before-listing');
    const beforeShop = $('#wiz-before-shop');

    const oldTags = createChipEditor($('[data-chips="wiz-old-tags"]'), counters);
    const newTags = createChipEditor($('[data-chips="wiz-new-tags"]'), counters);

    function counters() {
      updateCounter($('#wiz-old-title-count'), oldTitle.value.trim().length, RULES.titleMax, 120);
      updateCounter($('#wiz-new-title-count'), newTitle.value.trim().length, RULES.titleMax, 120);
      updateCounter($('#wiz-old-tags-count'), oldTags.get().length, RULES.tagMax);
      updateCounter($('#wiz-new-tags-count'), newTags.get().length, RULES.tagMax);
    }
    oldTitle.addEventListener('input', counters);
    newTitle.addEventListener('input', counters);

    function versions() {
      return {
        old: { title: oldTitle.value.trim(), tags: oldTags.get() },
        new: { title: newTitle.value.trim(), tags: newTags.get() },
      };
    }

    function show(n, focus) {
      step = n;
      steps.forEach((s) => { s.hidden = Number(s.dataset.step) !== n; });
      $('#wiz-bar').style.width = (n / total * 100) + '%';
      $('#wiz-count').textContent = `Step ${n} of ${total}`;
      back.style.visibility = n === 1 ? 'hidden' : 'visible';
      next.textContent = n === total ? 'Start the test' : 'Next';
      err.textContent = '';
      $$('.input', form).forEach((i) => i.classList.remove('is-invalid'));

      if (n === 3 && !newTitle.value.trim()) {
        newTitle.value = oldTitle.value.trim();
        newTags.set(oldTags.get());
      }
      if (n === total) {
        const v = versions();
        renderSwap($('#wiz-swap'), v.old, v.new, 'new');
      }
      counters();

      if (focus) {
        const target = {
          1: name, 2: oldTitle, 3: newTitle, 4: beforeListing, 5: next,
        }[n];
        if (target) target.focus({ preventScroll: true });
        const panelTop = $('#panel-test').getBoundingClientRect().top;
        if (panelTop < 0) $('#app').scrollIntoView({ behavior: 'smooth' });
      }
    }

    function validate(n) {
      $$('.input', form).forEach((i) => i.classList.remove('is-invalid'));
      if (n === 1) {
        if (!name.value.trim()) return fail(err, name, 'Give this listing a short name.');
      }
      if (n === 2) {
        oldTags.flush();
        if (!oldTitle.value.trim()) return fail(err, oldTitle, 'Paste the title that’s live on Etsy now.');
      }
      if (n === 3) {
        newTags.flush();
        const v = versions();
        if (!v.new.title) return fail(err, newTitle, 'Write the new title.');
        if (v.new.title.length > RULES.titleMax) return fail(err, newTitle, `Etsy allows up to ${RULES.titleMax} characters. Shorten the title by ${v.new.title.length - RULES.titleMax}.`);
        if (v.new.tags.length > RULES.tagMax) return fail(err, null, `Etsy allows ${RULES.tagMax} tags. Remove ${v.new.tags.length - RULES.tagMax}.`);
        const long = v.new.tags.find((t) => t.length > RULES.tagLength);
        if (long) return fail(err, null, `“${long}” is over Etsy’s ${RULES.tagLength}-character tag limit.`);
        const same = v.new.title === v.old.title &&
          v.new.tags.join('\n').toLowerCase() === v.old.tags.join('\n').toLowerCase();
        if (same) return fail(err, newTitle, 'The new version is the same as the current one. Change the title or tags first.');
      }
      if (n === 4) {
        const l = readWhole(beforeListing);
        const s = readWhole(beforeShop);
        if (l == null) return fail(err, beforeListing, 'Enter this listing’s views as a whole number.');
        if (s == null) return fail(err, beforeShop, 'Enter your whole shop’s views as a whole number.');
        if (s < l) return fail(err, beforeShop, 'Your shop’s views include this listing, so they can’t be lower than the listing’s.');
      }
      return true;
    }

    function reset() {
      form.reset();
      oldTags.set([]);
      newTags.set([]);
      show(1, false);
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!validate(step)) return;
      if (step < total) { show(step + 1, true); return; }

      const v = versions();
      const test = {
        id: makeId(),
        name: name.value.trim(),
        old: v.old,
        new: v.new,
        startedAt: new Date().toISOString(),
        before: { listing: readWhole(beforeListing), shop: readWhole(beforeShop) },
        after: null,
        result: null,
      };
      store.data.tests.unshift(test);
      store.save();
      renderTests();
      reset();
      selectTab('tests', true);
      toast(`Test started. Your verdict is ready on ${niceDate(addDays(test.startedAt, RULES.testDays))}.`);
    });

    back.addEventListener('click', () => { if (step > 1) show(step - 1, true); });

    show(1, false);
  }

  /* ================================================================
     MY TESTS
     ================================================================ */
  function ringSvg(fraction) {
    const r = 26;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - Math.max(0, Math.min(1, fraction)));
    return `<svg viewBox="0 0 64 64" aria-hidden="true">
      <circle class="ring-track" cx="32" cy="32" r="${r}"/>
      <circle class="ring-fill" cx="32" cy="32" r="${r}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"/>
    </svg>`;
  }

  function renderTests() {
    const tests = store.data.tests;
    const list = $('#tests-list');
    $('#tests-empty').hidden = tests.length > 0;
    $('#tests-count').textContent = tests.length ? String(tests.length) : '';

    list.innerHTML = tests.map((t) => {
      const elapsed = daysSince(t.startedAt);
      const left = Math.max(0, RULES.testDays - elapsed);
      let visual;
      let meta;
      let action;

      if (t.result) {
        const k = t.result.kind;
        visual = `<div class="verdict-badge badge-${k}">${BADGE_WORDS[k]}</div>`;
        const pts = k === 'data' ? '' : ` (${signed(t.result.points)} ${plural(Math.abs(t.result.points), 'point', 'points')})`;
        meta = `Started ${esc(niceDate(t.startedAt))}. Verdict: ${VERDICT_WORDS[k].toLowerCase()}${pts}.`;
        action = `<button class="btn btn-small" type="button" data-act="view" data-id="${esc(t.id)}">See the verdict</button>`;
      } else {
        const label = left > 0
          ? `<span><b>${left}</b>${plural(left, 'day', 'days')} left</span>`
          : '<span><b>✓</b>ready</span>';
        visual = `<div class="ring" role="img" aria-label="${left > 0 ? `${left} ${plural(left, 'day', 'days')} left` : 'Ready for its verdict'}">${ringSvg(elapsed / RULES.testDays)}<span class="ring-label">${label}</span></div>`;
        meta = left > 0
          ? `Started ${esc(niceDate(t.startedAt))}. Verdict ready on ${esc(niceDate(addDays(t.startedAt, RULES.testDays)))}.`
          : `Started ${esc(niceDate(t.startedAt))}. Ready for its verdict.`;
        action = `<button class="btn ${left > 0 ? 'btn-small' : 'btn-primary'}" type="button" data-act="results" data-id="${esc(t.id)}">Get the verdict</button>`;
      }

      return `<li class="test-row">
          ${visual}
          <div class="test-main">
            <p class="test-name">${esc(t.name)}</p>
            <p class="test-meta">${meta}</p>
            <div class="test-actions">
              ${action}
              <button class="btn btn-small" type="button" data-act="copy-old" data-id="${esc(t.id)}">Copy old title</button>
              <button class="btn-link" type="button" data-act="delete" data-id="${esc(t.id)}">Delete</button>
            </div>
          </div>
        </li>`;
    }).join('');
  }

  function setupTests() {
    $('#tests-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const test = findTest(btn.dataset.id);
      if (!test) return;
      const act = btn.dataset.act;
      if (act === 'results') openResults(test.id);
      if (act === 'view') showVerdict(test);
      if (act === 'copy-old') copyText(test.old.title, 'Old title');
      if (act === 'delete') {
        if (window.confirm(`Delete the test for “${test.name}”? This can’t be undone.`)) {
          store.data.tests = store.data.tests.filter((t) => t.id !== test.id);
          store.save();
          renderTests();
          toast('Test deleted');
        }
      }
    });

    $('#backup-download').addEventListener('click', () => {
      const payload = {
        app: 'listverdict',
        version: 1,
        exportedAt: new Date().toISOString(),
        tests: store.data.tests,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'listverdict-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Backup downloaded');
    });

    $('#backup-restore').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      const err = $('#backup-error');
      err.textContent = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (!data || data.app !== 'listverdict' || !Array.isArray(data.tests)) throw new Error('not a backup');
          const incoming = data.tests.filter(isValidTest);
          const have = new Set(store.data.tests.map((t) => t.id));
          const fresh = incoming.filter((t) => !have.has(t.id));
          store.data.tests = fresh.concat(store.data.tests)
            .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
          store.save();
          renderTests();
          toast(fresh.length ? `Restored ${fresh.length} ${plural(fresh.length, 'test', 'tests')}` : 'Those tests are already here');
        } catch (x) {
          err.textContent = 'That file isn’t a Listverdict backup. Choose the .json file you downloaded from here.';
        }
        e.target.value = '';
      };
      reader.readAsText(file);
    });

    $$('[data-tab-go]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tabGo, true)));
  }

  /* ================================================================
     TABS
     ================================================================ */
  const TAB_IDS = ['check', 'test', 'tests'];

  function selectTab(name, focusTab) {
    if (!TAB_IDS.includes(name)) name = 'check';
    TAB_IDS.forEach((id) => {
      const tab = $('#tab-' + id);
      const on = id === name;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      $('#panel-' + id).hidden = !on;
    });
    if (focusTab) $('#tab-' + name).focus({ preventScroll: true });
  }

  function setupTabs() {
    const tabs = $$('.tab');
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => selectTab(tab.dataset.tab));
      tab.addEventListener('keydown', (e) => {
        let j = null;
        if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
        if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
        if (e.key === 'Home') j = 0;
        if (e.key === 'End') j = tabs.length - 1;
        if (j != null) { e.preventDefault(); selectTab(tabs[j].dataset.tab, true); }
      });
    });
    selectTab('check');
  }

  /* ================================================================
     EMAIL GATE
     ================================================================ */
  let pendingTab = null;

  async function subscribe(email, consent) {
    if (!CONFIG.kitFormAction) return 'not-configured';
    const body = new FormData();
    body.append('email_address', email);
    if (CONFIG.kitConsentField) body.append('fields[' + CONFIG.kitConsentField + ']', consent ? 'yes' : 'no');

    const withTimeout = (opts) => {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null;
      return fetch(CONFIG.kitFormAction, Object.assign({ method: 'POST', body }, opts, ctrl ? { signal: ctrl.signal } : {}))
        .finally(() => { if (timer) clearTimeout(timer); });
    };

    try {
      const res = await withTimeout({ headers: { Accept: 'application/json' } });
      return res.ok ? 'sent' : 'error';
    } catch (e) {
      // Some setups block reading the reply. Send it anyway without reading the response.
      try {
        await withTimeout({ mode: 'no-cors' });
        return 'sent';
      } catch (e2) {
        return 'error';
      }
    }
  }

  function unlock() {
    $('#gate').hidden = true;
    $('#tool').hidden = false;
    selectTab(pendingTab || 'check', true);
    pendingTab = null;
  }

  function setupGate() {
    const form = $('#gate-form');
    const email = $('#gate-email');
    const err = $('#gate-error');
    const submit = $('#gate-submit');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      email.classList.remove('is-invalid');
      const value = email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
        fail(err, email, 'Enter a valid email address, like name@example.com.');
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Starting…';
      const status = await subscribe(value, $('#gate-consent').checked);
      if (status === 'error' && window.console) console.warn('Listverdict: the email could not be sent to Kit.');
      store.data.unlocked = true;
      store.save();
      submit.disabled = false;
      submit.textContent = 'Start using Listverdict';
      unlock();
      toast('You’re in. Welcome to Listverdict.');
    });
  }

  /* ================================================================
     START
     ================================================================ */
  function setupNavLinks() {
    $$('[data-go]').forEach((link) => {
      link.addEventListener('click', () => {
        const target = link.dataset.go;
        if (store.data.unlocked) {
          selectTab(target);
        } else {
          pendingTab = target;
          setTimeout(() => $('#gate-email').focus({ preventScroll: true }), 400);
        }
      });
    });
  }

  function setupKofi() {
    if (!CONFIG.kofiUrl) return;
    $('#kofi-link').href = CONFIG.kofiUrl;
    $('#kofi-wrap').hidden = false;
  }

  store.load();
  setupChecker();
  setupWizard();
  setupTests();
  setupTabs();
  setupGate();
  setupNavLinks();
  setupKofi();
  renderTests();

  if (store.data.unlocked) {
    $('#gate').hidden = true;
    $('#tool').hidden = false;
  }
})();
