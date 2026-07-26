/* Кондуит — редактор. Работает в браузере телефона, без сервера.

   Что делает: собирает кондуит серии (сетка «ученики × задачи»), правит список
   тем и отправляет изменения прямо в репозиторий через GitHub API. Публичный
   сайт после этого обновляется сам.

   Токен лежит только в localStorage этого браузера и уходит единственному
   адресату — api.github.com. Черновик сохраняется на каждое касание, поэтому
   без сети можно спокойно отмечать плюсы и отправить их позже. */

(function () {
  "use strict";

  var DATA = null;      // {config, types, students, series}
  var TOKEN = null;
  var DRAFTS = {};      // "07" -> {series, savedAt}
  var SENT = {};        // "19" -> когда отправлено; ждём, пока Pages выложит сайт
  var TYPES_DRAFT = null; // правки тем живут здесь, пока их не отправили

  var state = {
    view: "series",
    draft: null,        // редактируемая серия
    isNew: false,
    busy: false,
    note: "",           // сообщение вверху страницы
    noteKind: "",       // good | bad | ""
    sending: {},        // что сейчас в очереди отправки: ключ -> состояние
    confirmSub: null    // подраздел, удаление которого ждёт подтверждения
  };

  var LS_TOKEN = "conduit-token";
  var LS_DRAFTS = "conduit-drafts";
  var LS_SENT = "conduit-sent";
  var LS_TYPES = "conduit-types-draft";
  var LS_TYPES_SENT = "conduit-types-sent";
  var LETTERS = "абвгде";
  var MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн",
    "июл", "авг", "сен", "окт", "ноя", "дек"];

  // ── помощники ───────────────────────────────────────────

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function plural(n, one, few, many) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  function withNum(n, one, few, many) { return n + " " + plural(n, one, few, many); }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function shortDate(iso) {
    var p = String(iso).split("-");
    if (p.length !== 3) return iso;
    return Number(p[2]) + " " + MONTHS_SHORT[Number(p[1]) - 1];
  }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function lsGet(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function lsSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* приватный режим */ }
  }

  function lsDel(key) {
    try { localStorage.removeItem(key); } catch (e) { /* пусто */ }
  }

  // ── кодирование для GitHub API ──────────────────────────

  function b64FromUtf8(s) {
    var bytes = new TextEncoder().encode(s);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function utf8FromB64(b64) {
    var bin = atob(String(b64).replace(/\s/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // ── GitHub API ──────────────────────────────────────────

  function repo() { return DATA.config.repo || {}; }

  function api(path, opts) {
    var r = repo();
    if (!r.owner || !r.name) {
      return Promise.reject(new Error("в data/config.json не указан репозиторий"));
    }
    opts = opts || {};
    var headers = {
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (TOKEN) headers.Authorization = "Bearer " + TOKEN;
    if (opts.body) headers["Content-Type"] = "application/json";
    return fetch("https://api.github.com/repos/" + r.owner + "/" + r.name + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body
    }).then(function (res) {
      return res.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { /* не json */ }
        if (!res.ok) {
          var msg = (j && j.message) || ("HTTP " + res.status);
          if (res.status === 401) msg = "токен не принят (401) — проверь, не истёк ли он";
          if (res.status === 403) msg = "нет прав (403) — нужен доступ Contents: Read and write";
          if (res.status === 404) msg = "не найдено (404) — проверь ник, имя репозитория и права токена";
          if (res.status === 409) msg = "файл изменился на сервере (409) — обнови страницу и повтори";
          throw new Error(msg);
        }
        return j;
      });
    }, function () {
      throw new Error("нет связи с GitHub — черновик сохранён, отправь позже");
    });
  }

  function getFile(path) {
    return api("/contents/" + path + "?ref=" + (repo().branch || "main"))
      .then(function (j) {
        return { sha: j.sha, text: utf8FromB64(j.content) };
      })
      .catch(function (e) {
        if (/404/.test(e.message) || /не найдено/.test(e.message)) return null;
        throw e;
      });
  }

  function putFile(path, text, message, sha) {
    var body = {
      message: message,
      content: b64FromUtf8(text),
      branch: repo().branch || "main"
    };
    if (sha) body.sha = sha;
    return api("/contents/" + path, { method: "PUT", body: JSON.stringify(body) });
  }

  // ── черновики ───────────────────────────────────────────

  function loadDrafts() {
    try { DRAFTS = JSON.parse(lsGet(LS_DRAFTS, "{}")) || {}; } catch (e) { DRAFTS = {}; }
  }

  function saveDrafts() { lsSet(LS_DRAFTS, JSON.stringify(DRAFTS)); }

  function draftKey(n) { return pad2(n); }

  function touchDraft() {
    if (!state.draft) return;
    DRAFTS[draftKey(state.draft.n)] = { series: state.draft, savedAt: new Date().toISOString() };
    saveDrafts();
    renderSavebar();
  }

  function dropDraft(n) {
    delete DRAFTS[draftKey(n)];
    saveDrafts();
  }

  function loadSent() {
    try { SENT = JSON.parse(lsGet(LS_SENT, "{}")) || {}; } catch (e) { SENT = {}; }
  }

  /* Темы правятся так же, как серии: сначала локально, отправка — отдельным
     действием. Пока правка не уехала, редактор показывает её везде, чтобы новым
     подразделом можно было размечать задачи сразу. */
  function loadTypesDraft() {
    try {
      var raw = lsGet(LS_TYPES, null);
      TYPES_DRAFT = raw ? JSON.parse(raw) : null;
    } catch (e) { TYPES_DRAFT = null; }
  }

  function saveTypesDraft() {
    if (TYPES_DRAFT) lsSet(LS_TYPES, JSON.stringify(TYPES_DRAFT));
    else lsDel(LS_TYPES);
  }

  function types() { return TYPES_DRAFT || (DATA ? DATA.types : []); }

  function typesDirty() {
    return !!TYPES_DRAFT && JSON.stringify(TYPES_DRAFT) !== JSON.stringify(DATA.types);
  }

  /* Правка тем проходит те же три состояния, что и серия: не отправлена →
     отправлена, но сайт ещё не обновился → сайт догнал, копия не нужна.
     Снимок отправленного нужен, чтобы правка после отправки снова считалась
     неотправленной. */
  function typesSentSnapshot() {
    try { return JSON.parse(lsGet(LS_TYPES_SENT, "null")); } catch (e) { return null; }
  }

  function markTypesSent() {
    lsSet(LS_TYPES_SENT, JSON.stringify({
      at: new Date().toISOString(),
      snapshot: JSON.stringify(TYPES_DRAFT)
    }));
  }

  function typesWaiting() {
    var sent = typesSentSnapshot();
    return typesDirty() && !!sent && sent.snapshot === JSON.stringify(TYPES_DRAFT);
  }

  function typesPending() {
    return typesDirty() && !typesWaiting();
  }

  function editTypes() {
    if (!TYPES_DRAFT) TYPES_DRAFT = JSON.parse(JSON.stringify(DATA.types));
    return TYPES_DRAFT;
  }

  function typeById(id) {
    return types().filter(function (t) { return t.id === id; })[0] || null;
  }

  /* Что нового в правке тем по сравнению с тем, что уже на сайте. */
  function typesAdded() {
    if (!TYPES_DRAFT) return { cats: [], subs: [] };
    var cats = [], subs = [];
    var old = {};
    DATA.types.forEach(function (t) {
      old[t.id] = {};
      (t.subs || []).forEach(function (s) { old[t.id][s.id] = true; });
    });
    TYPES_DRAFT.forEach(function (t) {
      if (!old[t.id]) { cats.push(t.name); return; }
      (t.subs || []).forEach(function (s) {
        if (!old[t.id][s.id]) subs.push(t.name + " · " + s.name);
      });
    });
    return { cats: cats, subs: subs };
  }

  /* Сколько задач уже помечено этим подразделом — и на сайте, и в черновиках.
     Удалять его можно, но тогда у этих задач останется метка, которой больше
     нет в списке тем: сайт покажет её кодом, пока задачи не переразметить. */
  function subUsage(catId, subId) {
    var n = 0;
    DATA.series.forEach(function (s) {
      (s.problems || []).forEach(function (p) {
        if (p.type === catId && (p.sub || null) === subId) n += 1;
      });
    });
    Object.keys(DRAFTS).forEach(function (k) {
      (DRAFTS[k].series.problems || []).forEach(function (p) {
        if (p.type === catId && (p.sub || null) === subId) n += 1;
      });
    });
    return n;
  }

  function isNewSub(catId, subId) {
    var cat = DATA.types.filter(function (t) { return t.id === catId; })[0];
    if (!cat) return true;
    return !(cat.subs || []).some(function (s) { return s.id === subId; });
  }

  function markSent(n) {
    SENT[draftKey(n)] = new Date().toISOString();
    lsSet(LS_SENT, JSON.stringify(SENT));
  }

  /* Сайт обновляется не мгновенно: пока Pages не переразвернулся, отправленной
     серии в данных ещё нет. Держим её в списке помеченной, чтобы её нельзя было
     случайно создать заново поверх уже отправленной. */
  function pruneSent() {
    var changed = false;
    Object.keys(SENT).forEach(function (key) {
      if (seriesByNumber(Number(key))) { delete SENT[key]; changed = true; }
    });
    if (changed) lsSet(LS_SENT, JSON.stringify(SENT));

    // темы догнали сайт — локальная копия больше не нужна
    if (TYPES_DRAFT && JSON.stringify(TYPES_DRAFT) === JSON.stringify(DATA.types)) {
      TYPES_DRAFT = null;
      saveTypesDraft();
      lsDel(LS_TYPES_SENT);
    }
  }

  // ── работа с сериями ────────────────────────────────────

  function seriesByNumber(n) {
    return DATA.series.filter(function (s) { return s.n === n; })[0] || null;
  }

  function nextNumber() {
    var max = 0;
    DATA.series.forEach(function (s) { if (s.n > max) max = s.n; });
    Object.keys(DRAFTS).forEach(function (k) {
      var n = DRAFTS[k].series.n;
      if (n > max) max = n;
    });
    Object.keys(SENT).forEach(function (k) {
      var n = Number(k);
      if (n > max) max = n;
    });
    return max + 1;
  }

  function blankSeries(n) {
    var solved = {};
    DATA.students.forEach(function (s) { solved[s.id] = []; });
    return { n: n, date: todayISO(), problems: [], solved: solved };
  }

  function openSeries(n) {
    var key = draftKey(n);
    if (DRAFTS[key]) {
      state.draft = JSON.parse(JSON.stringify(DRAFTS[key].series));
      state.isNew = !seriesByNumber(n);
    } else {
      var s = seriesByNumber(n);
      state.isNew = !s;
      if (s) {
        state.draft = JSON.parse(JSON.stringify({
          n: s.n, date: s.date, problems: s.problems, solved: s.solved
        }));
        // ученик мог появиться после того, как серия была записана
        DATA.students.forEach(function (st) {
          if (!state.draft.solved[st.id]) state.draft.solved[st.id] = [];
        });
      } else {
        state.draft = blankSeries(n);
      }
    }
    state.note = "";
    render();
  }

  function toggleMark(studentId, pid) {
    var list = state.draft.solved[studentId] || (state.draft.solved[studentId] = []);
    var i = list.indexOf(pid);
    if (i === -1) list.push(pid); else list.splice(i, 1);
    touchDraft();
  }

  function solvedCount(pid) {
    var c = 0;
    DATA.students.forEach(function (s) {
      var list = state.draft.solved[s.id];
      if (list && list.indexOf(pid) !== -1) c += 1;
    });
    return c;
  }

  function renameProblem(oldId, newId) {
    state.draft.problems.forEach(function (p) { if (p.id === oldId) p.id = newId; });
    Object.keys(state.draft.solved).forEach(function (sid) {
      var list = state.draft.solved[sid];
      var i = list.indexOf(oldId);
      if (i !== -1) list[i] = newId;
    });
  }

  function removeProblem(pid) {
    state.draft.problems = state.draft.problems.filter(function (p) { return p.id !== pid; });
    Object.keys(state.draft.solved).forEach(function (sid) {
      state.draft.solved[sid] = state.draft.solved[sid].filter(function (x) { return x !== pid; });
    });
  }

  function numPrefix(id) {
    var m = String(id).match(/^(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  function addProblem() {
    var max = 0;
    state.draft.problems.forEach(function (p) {
      var n = numPrefix(p.id);
      if (n > max) max = n;
    });
    var first = types()[0];
    state.draft.problems.push({
      id: String(max + 1),
      type: first.id,
      sub: first.subs && first.subs.length ? first.subs[0].id : null
    });
    touchDraft();
  }

  function addPart() {
    var ps = state.draft.problems;
    if (!ps.length) return addProblem();
    var lastNum = numPrefix(ps[ps.length - 1].id);
    var family = ps.filter(function (p) { return numPrefix(p.id) === lastNum; });
    var sample = family[family.length - 1];

    if (family.length === 1 && String(sample.id) === String(lastNum)) {
      // была цельная задача 5 — становится 5а, добавляем 5б
      renameProblem(sample.id, lastNum + LETTERS[0]);
      insertAfter(sample, { id: lastNum + LETTERS[1], type: sample.type, sub: sample.sub });
    } else {
      var letter = LETTERS[family.length] || LETTERS[LETTERS.length - 1];
      insertAfter(sample, { id: lastNum + letter, type: sample.type, sub: sample.sub });
    }
    touchDraft();
  }

  function insertAfter(anchor, item) {
    var i = state.draft.problems.indexOf(anchor);
    state.draft.problems.splice(i === -1 ? state.draft.problems.length : i + 1, 0, item);
  }

  function validate(d) {
    if (!d) return "нечего отправлять";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return "не указана дата";
    if (!d.problems.length) return "не добавлено ни одной задачи";
    var seen = {};
    for (var i = 0; i < d.problems.length; i++) {
      var p = d.problems[i];
      var id = String(p.id).trim();
      if (!id) return "у задачи пустой номер";
      if (seen[id]) return "номер задачи «" + id + "» встречается дважды";
      seen[id] = true;
      if (!p.type) return "у задачи " + id + " не выбрана тема";
    }
    return null;
  }

  // ── отправка ────────────────────────────────────────────

  /* Отправка одной серии. Возвращает обещание, чтобы «отправить всё» могло
     выстроить очередь: темы первыми, потом серии. */
  function sendSeries(n) {
    var entry = DRAFTS[draftKey(n)];
    if (!entry) return Promise.reject(new Error("черновик серии " + n + " не найден"));
    var d = entry.series;
    var problem = validate(d);
    if (problem) return Promise.reject(new Error(problem));

    var file = "data/series/" + pad2(d.n) + ".json";
    var payload = {
      n: d.n,
      date: d.date,
      title: "Серия " + d.n,
      problems: d.problems.map(function (p) {
        return { id: String(p.id).trim(), type: p.type, sub: p.sub || null };
      }),
      solved: {}
    };
    DATA.students.forEach(function (s) {
      payload.solved[s.id] = (d.solved[s.id] || []).slice().sort(cmpIds);
    });

    var pluses = Object.keys(payload.solved).reduce(function (a, k) {
      return a + payload.solved[k].length;
    }, 0);

    return getFile(file)
      .then(function (cur) {
        return putFile(file, JSON.stringify(payload, null, 2) + "\n",
          "Серия " + d.n + " (" + shortDate(d.date) + "): " +
          withNum(payload.problems.length, "задача", "задачи", "задач") + ", " +
          withNum(pluses, "плюс", "плюса", "плюсов"),
          cur && cur.sha);
      })
      .then(function () { return ensureManifest(pad2(d.n) + ".json"); })
      .then(function () {
        dropDraft(d.n);
        markSent(d.n);
        if (state.draft && state.draft.n === d.n) state.draft = null;
      });
  }

  function sendTypes() {
    if (!TYPES_DRAFT) return Promise.resolve();
    var added = typesAdded();
    var what = added.cats.concat(added.subs);
    var path = "data/types.json";
    var payload = TYPES_DRAFT;
    return getFile(path).then(function (cur) {
      return putFile(path, JSON.stringify(payload, null, 2) + "\n",
        "Темы: " + (what.length ? "добавлено — " + what.join(", ") : "правка"),
        cur && cur.sha);
    }).then(function () { markTypesSent(); });
  }

  function ensureManifest(name) {
    var path = "data/series/manifest.json";
    return getFile(path).then(function (cur) {
      var list = [];
      if (cur) {
        try { list = (JSON.parse(cur.text).series || []).slice(); } catch (e) { list = []; }
      }
      if (list.indexOf(name) !== -1) return null;
      list.push(name);
      list.sort();
      return putFile(path, JSON.stringify({ series: list }, null, 2) + "\n",
        "Список серий: добавлена " + name, cur && cur.sha);
    });
  }

  function cmpIds(a, b) {
    var na = numPrefix(a), nb = numPrefix(b);
    return na - nb || String(a).localeCompare(String(b), "ru");
  }

  // ── темы ────────────────────────────────────────────────

  function translit(name) {
    var table = {
      "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
      "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
      "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
      "ф": "f", "х": "h", "ц": "c", "ч": "ch", "ш": "sh", "щ": "sch",
      "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya", " ": "-", "-": "-"
    };
    var out = "";
    String(name).toLowerCase().split("").forEach(function (ch) {
      out += table[ch] !== undefined ? table[ch] : (/[a-z0-9]/.test(ch) ? ch : "");
    });
    return out.replace(/-+/g, "-").replace(/^-|-$/g, "") || "sub";
  }

  function uniqueId(base, taken) {
    var id = base, i = 2;
    while (taken.indexOf(id) !== -1) { id = base + "-" + i; i += 1; }
    return id;
  }

  // ── общие детали ────────────────────────────────────────

  function dot(slot) {
    var d = el("span", "dot");
    d.style.background = "var(--s" + slot + ")";
    return d;
  }

  function field(label, node) {
    var f = el("label", "field");
    f.appendChild(el("span", "field-label", label));
    f.appendChild(node);
    return f;
  }

  function button(text, cls, fn) {
    var b = el("button", cls || "ghost-btn", text);
    b.type = "button";
    b.addEventListener("click", fn);
    return b;
  }

  // ── вид: серия ──────────────────────────────────────────

  function viewSeries(host) {
    // выбор серии
    var picker = el("div", "card");
    var head = el("div", "filter-head");
    head.appendChild(el("span", "filter-title", "Какую серию правим"));
    picker.appendChild(head);

    var chips = el("div", "chips");
    DATA.series.forEach(function (s) {
      var key = draftKey(s.n);
      var b = el("button", "chip day" + (DRAFTS[key] ? " has-draft" : ""));
      b.type = "button";
      b.setAttribute("aria-pressed", state.draft && state.draft.n === s.n ? "true" : "false");
      b.appendChild(el("b", null, s.n));
      b.appendChild(el("small", null, shortDate(s.date)));
      b.addEventListener("click", function () { openSeries(s.n); });
      chips.appendChild(b);
    });

    // черновики новых серий, которых ещё нет на сайте
    Object.keys(DRAFTS).sort().forEach(function (key) {
      var d = DRAFTS[key].series;
      if (seriesByNumber(d.n)) return;
      var b = el("button", "chip day has-draft");
      b.type = "button";
      b.setAttribute("aria-pressed", state.draft && state.draft.n === d.n ? "true" : "false");
      b.appendChild(el("b", null, d.n));
      b.appendChild(el("small", null, shortDate(d.date)));
      b.addEventListener("click", function () { openSeries(d.n); });
      chips.appendChild(b);
    });

    // отправленные, но ещё не выложенные Pages
    Object.keys(SENT).sort().forEach(function (key) {
      var n = Number(key);
      if (seriesByNumber(n) || DRAFTS[key]) return;
      var b = el("button", "chip day pending");
      b.type = "button";
      b.setAttribute("aria-pressed", "false");
      b.appendChild(el("b", null, n));
      b.appendChild(el("small", null, "ждём"));
      b.addEventListener("click", function () {
        state.note = "Серия " + n + " уже отправлена, но сайт ещё не обновился. " +
          "Подожди минуту и обнови страницу — тогда её можно будет править.";
        state.noteKind = "bad";
        render();
      });
      chips.appendChild(b);
    });

    var add = el("button", "chip day new");
    add.type = "button";
    add.setAttribute("aria-pressed", "false");
    add.appendChild(el("b", null, "+"));
    add.appendChild(el("small", null, "новая"));
    add.addEventListener("click", function () { openSeries(nextNumber()); });
    chips.appendChild(add);

    picker.appendChild(chips);

    var hint = el("div", "summary");
    hint.textContent = Object.keys(DRAFTS).length
      ? "Точка на кнопке — есть неотправленный черновик."
      : "Кнопка «+» создаёт следующую серию.";
    picker.appendChild(hint);
    host.appendChild(picker);

    if (!state.draft) return;

    // шапка серии
    var meta = el("div", "card");
    var mrow = el("div", "frow");

    var numInput = el("input");
    numInput.type = "number";
    numInput.min = "1";
    numInput.value = state.draft.n;
    numInput.className = "input short";
    numInput.addEventListener("change", function () {
      var v = parseInt(numInput.value, 10);
      if (!v || v < 1) { numInput.value = state.draft.n; return; }
      dropDraft(state.draft.n);
      state.draft.n = v;
      state.isNew = !seriesByNumber(v);
      touchDraft();
      render();
    });
    mrow.appendChild(field("Номер серии", numInput));

    var dateInput = el("input");
    dateInput.type = "date";
    dateInput.value = state.draft.date;
    dateInput.className = "input";
    dateInput.addEventListener("change", function () {
      state.draft.date = dateInput.value;
      touchDraft();
    });
    mrow.appendChild(field("Дата", dateInput));

    meta.appendChild(mrow);

    var where = el("div", "summary");
    where.textContent = (state.isNew ? "Новая серия → " : "Правим существующую → ") +
      "data/series/" + pad2(state.draft.n) + ".json";
    meta.appendChild(where);
    host.appendChild(meta);

    // задачи
    var sh = el("div", "section-head");
    sh.appendChild(el("span", "section-title", "Задачи"));
    sh.appendChild(el("span", "section-note",
      withNum(state.draft.problems.length, "единица", "единицы", "единиц") + " зачёта"));
    host.appendChild(sh);

    var pcard = el("div", "card");
    state.draft.problems.forEach(function (p) { pcard.appendChild(problemRow(p)); });

    var actions = el("div", "frow gap");
    actions.appendChild(button("+ задача", "ghost-btn", function () { addProblem(); render(); }));
    actions.appendChild(button("+ пункт", "ghost-btn", function () { addPart(); render(); }));
    pcard.appendChild(actions);
    host.appendChild(pcard);

    if (!state.draft.problems.length) return;

    // сетка
    var sh2 = el("div", "section-head");
    sh2.appendChild(el("span", "section-title", "Кондуит"));
    sh2.appendChild(el("span", "section-note", "касание клетки ставит и снимает плюс"));
    host.appendChild(sh2);

    host.appendChild(grid());

    var problem = validate(state.draft);
    var status = el("div", "card draft-status");
    var line = el("div", "sendrow");
    var left = el("div", "sendrow-main");
    left.appendChild(el("div", "sendrow-title",
      problem ? "Пока нельзя отправить: " + problem : "Черновик сохранён"));
    left.appendChild(el("div", "sendrow-note",
      "Серия " + state.draft.n + " · " +
      withNum(state.draft.problems.length, "задача", "задачи", "задач") + " · " +
      withNum(totalPluses(), "плюс", "плюса", "плюсов") +
      ". Хранится в памяти телефона, пока не отправишь."));
    line.appendChild(left);
    var go = button("К отправке", "primary-btn", function () {
      state.view = "send";
      render();
      window.scrollTo(0, 0);
    });
    go.disabled = !!problem;
    line.appendChild(go);
    status.appendChild(line);
    host.appendChild(status);
  }

  function problemRow(p) {
    var row = el("div", "prow");

    var idIn = el("input");
    idIn.className = "input tiny";
    idIn.value = p.id;
    idIn.addEventListener("change", function () {
      var v = String(idIn.value).trim();
      if (!v) { idIn.value = p.id; return; }
      renameProblem(p.id, v);
      touchDraft();
      render();
    });
    row.appendChild(idIn);

    var catSel = el("select", "input");
    types().forEach(function (t) {
      var o = el("option", null, t.name);
      o.value = t.id;
      if (t.id === p.type) o.selected = true;
      catSel.appendChild(o);
    });
    catSel.addEventListener("change", function () {
      p.type = catSel.value;
      var t = typeById(p.type);
      p.sub = t && t.subs && t.subs.length ? t.subs[0].id : null;
      touchDraft();
      render();
    });
    row.appendChild(catSel);

    var t = typeById(p.type);
    var subSel = el("select", "input");
    if (t && t.subs && t.subs.length) {
      t.subs.forEach(function (s) {
        var o = el("option", null, s.name);
        o.value = s.id;
        if (s.id === p.sub) o.selected = true;
        subSel.appendChild(o);
      });
      var none = el("option", null, "без уточнения");
      none.value = "";
      if (!p.sub) none.selected = true;
      subSel.appendChild(none);
      subSel.addEventListener("change", function () {
        p.sub = subSel.value || null;
        touchDraft();
      });
    } else {
      var only = el("option", null, "—");
      only.value = "";
      subSel.appendChild(only);
      subSel.disabled = true;
    }
    row.appendChild(subSel);

    row.appendChild(button("×", "icon-btn", function () {
      removeProblem(p.id);
      touchDraft();
      render();
    }));

    var mark = el("span", "prow-dot");
    mark.appendChild(dot(t ? t.slot : 1));
    row.appendChild(mark);

    return row;
  }

  function grid() {
    var scroll = el("div", "conduit-scroll");
    var table = el("table", "conduit edit");
    var problems = state.draft.problems;

    var thead = el("thead");
    var hr = el("tr");
    hr.appendChild(el("th", "pname", "Ученик"));
    problems.forEach(function (p) {
      var t = typeById(p.type);
      var cell = el("th");
      var box = el("div", "phead");
      box.appendChild(el("div", "phead-id", p.id));
      var rule = el("div", "phead-rule");
      rule.style.background = "var(--s" + (t ? t.slot : 1) + ")";
      box.appendChild(rule);
      cell.appendChild(box);
      hr.appendChild(cell);
    });
    hr.appendChild(el("th", "pcount", "всего"));
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el("tbody");
    DATA.students.forEach(function (st) {
      var tr = el("tr", "crow");
      tr.appendChild(el("td", "pname", st.name));
      var list = state.draft.solved[st.id] || [];
      problems.forEach(function (p) {
        var td = el("td", "cell");
        var b = el("button", "mark" + (list.indexOf(p.id) !== -1 ? " on" : ""));
        b.type = "button";
        b.setAttribute("aria-label", st.name + ", задача " + p.id);
        b.addEventListener("click", function () {
          toggleMark(st.id, p.id);
          var on = (state.draft.solved[st.id] || []).indexOf(p.id) !== -1;
          b.className = "mark" + (on ? " on" : "");
          updateCounters(table);
        });
        td.appendChild(b);
        tr.appendChild(td);
      });
      tr.appendChild(el("td", "pcount rowcount", list.length));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    var tfoot = el("tfoot");
    var f1 = el("tr");
    f1.appendChild(el("td", "pname", "решили"));
    problems.forEach(function (p) { f1.appendChild(el("td", "colcount", solvedCount(p.id))); });
    f1.appendChild(el("td", "pcount total", totalPluses()));
    tfoot.appendChild(f1);
    var f2 = el("tr", "weights");
    f2.appendChild(el("td", "pname", "вес"));
    problems.forEach(function (p) {
      f2.appendChild(el("td", "colweight", DATA.config.students_total - solvedCount(p.id)));
    });
    f2.appendChild(el("td", "pcount"));
    tfoot.appendChild(f2);
    table.appendChild(tfoot);

    scroll.appendChild(table);
    return scroll;
  }

  function totalPluses() {
    return DATA.students.reduce(function (a, s) {
      return a + ((state.draft.solved[s.id] || []).length);
    }, 0);
  }

  function updateCounters(table) {
    var problems = state.draft.problems;
    var rows = table.querySelectorAll("tbody tr");
    DATA.students.forEach(function (st, i) {
      var c = rows[i].querySelector(".rowcount");
      if (c) c.textContent = (state.draft.solved[st.id] || []).length;
    });
    var cols = table.querySelectorAll(".colcount");
    var ws = table.querySelectorAll(".colweight");
    problems.forEach(function (p, i) {
      var n = solvedCount(p.id);
      if (cols[i]) cols[i].textContent = n;
      if (ws[i]) ws[i].textContent = DATA.config.students_total - n;
    });
    var total = table.querySelector(".total");
    if (total) total.textContent = totalPluses();
  }

  // ── вид: темы ───────────────────────────────────────────

  function viewThemes(host) {
    var note = el("div", "section-note");
    note.textContent = "Добавленный подраздел сразу появляется в выборе при разметке задач. " +
      "На сайт он попадёт после отправки — во вкладке «Отправка». " +
      "Уже записанные серии не изменятся.";
    host.appendChild(note);

    var card = el("div", "card");
    types().forEach(function (t) {
      var block = el("div", "tblock");

      var head = el("div", "tblock-head");
      var nameBox = el("span", "type-name");
      nameBox.appendChild(dot(t.slot));
      nameBox.appendChild(el("b", null, t.name));
      head.appendChild(nameBox);
      head.appendChild(el("span", "type-val",
        (t.subs || []).length
          ? withNum(t.subs.length, "подраздел", "подраздела", "подразделов")
          : "без подразбиения"));
      block.appendChild(head);

      (t.subs || []).forEach(function (s) {
        var isNew = isNewSub(t.id, s.id);
        var key = t.id + "/" + s.id;

        var line = el("div", "subline");
        var name = el("span", "subline-name");
        name.appendChild(document.createTextNode(s.name));
        if (isNew) {
          name.appendChild(el("span", "badge",
            typesWaiting() ? "ждём сайт" : "не отправлено"));
        }
        line.appendChild(name);

        var used = subUsage(t.id, s.id);
        if (state.confirmSub === key) {
          var box = el("span", "confirm");
          box.appendChild(el("span", "confirm-text",
            used ? "стоит у " + withNum(used, "задачи", "задач", "задач") + ". Удалить?"
              : "удалить?"));
          box.appendChild(button("да", "mini-btn danger", function () {
            var draft = editTypes();
            var cat = draft.filter(function (x) { return x.id === t.id; })[0];
            cat.subs = cat.subs.filter(function (x) { return x.id !== s.id; });
            state.confirmSub = null;
            saveTypesDraft();
            render();
          }));
          box.appendChild(button("нет", "mini-btn", function () {
            state.confirmSub = null;
            render();
          }));
          line.appendChild(box);
        } else {
          var right = el("span", "subline-right");
          if (used) right.appendChild(el("span", "subline-val", used + " зад."));
          right.appendChild(button("убрать", "mini-btn", function () {
            state.confirmSub = key;
            render();
          }));
          line.appendChild(right);
        }

        block.appendChild(line);
      });

      var add = el("div", "frow gap");
      var input = el("input");
      input.className = "input";
      input.placeholder = "новый подраздел";
      add.appendChild(input);
      add.appendChild(button("добавить", "ghost-btn", function () {
        var name = String(input.value).trim();
        if (!name) return;
        var draft = editTypes();
        var taken = [];
        draft.forEach(function (x) {
          (x.subs || []).forEach(function (s) { taken.push(s.id); });
        });
        var cat = draft.filter(function (x) { return x.id === t.id; })[0];
        if (!cat.subs) cat.subs = [];
        cat.subs.push({ id: uniqueId(translit(name), taken), name: name });
        saveTypesDraft();
        render();
      }));
      block.appendChild(add);

      card.appendChild(block);
    });
    host.appendChild(card);

    var sh = el("div", "section-head");
    sh.appendChild(el("span", "section-title", "Новый раздел"));
    host.appendChild(sh);

    var card2 = el("div", "card");
    var row = el("div", "frow gap");
    var nameIn = el("input");
    nameIn.className = "input";
    nameIn.placeholder = "название раздела";
    row.appendChild(nameIn);

    var slotSel = el("select", "input short");
    var used = types().map(function (t) { return t.slot; });
    for (var i = 1; i <= 8; i++) {
      if (used.indexOf(i) !== -1) continue;
      var o = el("option", null, "цвет " + i);
      o.value = i;
      slotSel.appendChild(o);
    }
    if (!slotSel.options.length) {
      var o2 = el("option", null, "цвета кончились");
      o2.value = "";
      slotSel.appendChild(o2);
      slotSel.disabled = true;
    }
    row.appendChild(slotSel);

    row.appendChild(button("добавить", "ghost-btn", function () {
      var name = String(nameIn.value).trim();
      if (!name || !slotSel.value) return;
      var draft = editTypes();
      var taken = draft.map(function (t) { return t.id; });
      draft.push({
        id: uniqueId(translit(name), taken),
        name: name,
        slot: Number(slotSel.value),
        subs: []
      });
      saveTypesDraft();
      render();
    }));
    card2.appendChild(row);
    card2.appendChild(el("div", "summary",
      "Цветов всего восемь — они проверены на различимость, в том числе при дальтонизме."));
    host.appendChild(card2);

    if (typesPending()) {
      var added = typesAdded();
      var pending = el("div", "card");
      pending.appendChild(el("div", "tblock-head", "Не отправлено"));
      added.cats.forEach(function (n) {
        pending.appendChild(el("div", "subline", "новый раздел: " + n));
      });
      added.subs.forEach(function (n) {
        pending.appendChild(el("div", "subline", "новый подраздел: " + n));
      });
      var go = el("div", "frow gap");
      go.appendChild(button("Перейти к отправке", "primary-btn", function () {
        state.view = "send";
        render();
      }));
      pending.appendChild(go);
      host.appendChild(pending);
    }
  }

  // ── вид: доступ ─────────────────────────────────────────

  function viewAccess(host) {
    var r = repo();

    var card = el("div", "card");
    var sh = el("div", "tblock-head");
    sh.appendChild(el("span", "type-name", "Токен GitHub"));
    sh.appendChild(el("span", "type-val", TOKEN ? "сохранён" : "не задан"));
    card.appendChild(sh);

    var input = el("input");
    input.className = "input";
    input.type = "password";
    input.autocomplete = "off";
    input.placeholder = TOKEN ? "••••••••  (введите, чтобы заменить)" : "github_pat_…";
    card.appendChild(field("Токен", input));

    var row = el("div", "frow gap");
    row.appendChild(button("Сохранить", "primary-btn", function () {
      var v = String(input.value).trim();
      if (!v) return;
      TOKEN = v;
      lsSet(LS_TOKEN, v);
      input.value = "";
      state.note = "токен сохранён, проверяю доступ…";
      render();
      check();
    }));
    row.appendChild(button("Проверить доступ", "ghost-btn", check));
    row.appendChild(button("Удалить", "ghost-btn", function () {
      TOKEN = null;
      lsDel(LS_TOKEN);
      state.note = "токен удалён из этого браузера";
      render();
    }));
    card.appendChild(row);

    var st = el("div", "summary", (!state.noteKind && state.note) || " ");
    st.id = "access-status";
    card.appendChild(st);
    host.appendChild(card);

    var help = el("div", "card");
    help.appendChild(el("div", "tblock-head", "Куда пишем"));
    help.appendChild(el("div", "summary",
      (r.owner || "?") + "/" + (r.name || "?") + ", ветка " + (r.branch || "main")));
    help.appendChild(el("div", "foot",
      "Токен нужен fine-grained, с доступом только к этому репозиторию и правом " +
      "Contents: Read and write. Он хранится в памяти этого браузера и отправляется " +
      "только на api.github.com. Если телефон потеряется — отзови токен в настройках " +
      "GitHub, и он мгновенно перестанет работать."));
    host.appendChild(help);

    if (Object.keys(DRAFTS).length) {
      var sh2 = el("div", "section-head");
      sh2.appendChild(el("span", "section-title", "Черновики"));
      sh2.appendChild(el("span", "section-note", "хранятся только на этом телефоне"));
      host.appendChild(sh2);

      var dcard = el("div", "card");
      Object.keys(DRAFTS).sort().forEach(function (key) {
        var d = DRAFTS[key];
        var line = el("div", "subline");
        line.appendChild(el("span", "subline-name",
          "Серия " + d.series.n + " · " + shortDate(d.series.date) + " · " +
          withNum(d.series.problems.length, "задача", "задачи", "задач")));
        var btns = el("span", "frow");
        btns.appendChild(button("открыть", "mini-btn", function () {
          state.view = "series";
          openSeries(d.series.n);
        }));
        btns.appendChild(button("удалить", "mini-btn", function () {
          dropDraft(d.series.n);
          if (state.draft && state.draft.n === d.series.n) state.draft = null;
          render();
        }));
        line.appendChild(btns);
        dcard.appendChild(line);
      });
      host.appendChild(dcard);
    }
  }

  function check() {
    if (!TOKEN) {
      state.note = "токен не задан";
      return render();
    }
    state.note = "проверяю…";
    render();
    api("").then(function (j) {
      var perm = j.permissions && j.permissions.push;
      state.note = "доступ есть: " + j.full_name + (perm ? ", запись разрешена" : ", но запись не разрешена");
      render();
    }).catch(function (e) {
      state.note = "не вышло: " + e.message;
      render();
    });
  }

  // ── каркас ──────────────────────────────────────────────

  // ── вид: отправка ───────────────────────────────────────

  function pendingItems() {
    var items = [];
    if (typesPending()) {
      var added = typesAdded();
      items.push({
        key: "types",
        title: "Темы",
        note: added.cats.concat(added.subs).join(", ") || "правка списка тем",
        problem: null
      });
    }
    Object.keys(DRAFTS).sort().forEach(function (k) {
      var d = DRAFTS[k].series;
      var pluses = Object.keys(d.solved || {}).reduce(function (a, id) {
        return a + (d.solved[id] || []).length;
      }, 0);
      items.push({
        key: "series:" + d.n,
        n: d.n,
        title: "Серия " + d.n,
        note: shortDate(d.date) + " · " +
          withNum((d.problems || []).length, "задача", "задачи", "задач") + " · " +
          withNum(pluses, "плюс", "плюса", "плюсов"),
        problem: validate(d)
      });
    });
    return items;
  }

  function viewSend(host) {
    var items = pendingItems();

    if (!TOKEN) {
      var warn = el("div", "card");
      warn.appendChild(el("div", "tblock-head", "Нужен токен"));
      warn.appendChild(el("div", "summary",
        "Без токена отправлять некуда. Черновики при этом в безопасности — " +
        "они лежат в памяти этого браузера."));
      var go = el("div", "frow gap");
      go.appendChild(button("К настройке доступа", "primary-btn", function () {
        state.view = "access";
        render();
      }));
      warn.appendChild(go);
      host.appendChild(warn);
    }

    if (!items.length) {
      var ok = el("div", "card");
      ok.appendChild(el("div", "tblock-head", "Всё отправлено"));
      ok.appendChild(el("div", "summary",
        "Неотправленных правок нет. Отмечай плюсы во вкладке «Серия» — " +
        "они появятся здесь."));
      host.appendChild(ok);
    } else {
      var head = el("div", "section-head");
      head.appendChild(el("span", "section-title", "Не отправлено"));
      head.appendChild(el("span", "section-note",
        withNum(items.length, "правка", "правки", "правок")));
      host.appendChild(head);

      var card = el("div", "card");
      items.forEach(function (it) {
        var row = el("div", "sendrow");

        var left = el("div", "sendrow-main");
        var title = el("div", "sendrow-title");
        title.appendChild(el("b", null, it.title));
        if (it.problem) title.appendChild(el("span", "badge bad", it.problem));
        left.appendChild(title);
        left.appendChild(el("div", "sendrow-note", it.note));
        if (state.sending[it.key]) {
          left.appendChild(el("div", "sendrow-status " +
            (/^ошибка/.test(state.sending[it.key]) ? "bad" : ""), state.sending[it.key]));
        }
        row.appendChild(left);

        var btn = button(it.problem ? "нельзя" : "Отправить", "ghost-btn", function () {
          runQueue([it]);
        });
        btn.disabled = state.busy || !!it.problem || !TOKEN;
        row.appendChild(btn);

        card.appendChild(row);
      });
      host.appendChild(card);

      var all = el("div", "frow gap");
      var allBtn = button(state.busy ? "Отправляю…" : "Отправить всё", "primary-btn", function () {
        runQueue(items.filter(function (it) { return !it.problem; }));
      });
      allBtn.disabled = state.busy || !TOKEN ||
        !items.some(function (it) { return !it.problem; });
      all.appendChild(allBtn);
      host.appendChild(all);

      host.appendChild(el("div", "foot",
        "Темы уходят первыми, потом серии — иначе задача с новым подразделом " +
        "попала бы на сайт раньше самого подраздела. Если связи нет, ничего не " +
        "теряется: черновики остаются, попробуй позже."));
    }

    var waiting = Object.keys(SENT).filter(function (k) {
      return !seriesByNumber(Number(k));
    });
    if (waiting.length || typesWaiting()) {
      var what = [];
      if (typesWaiting()) what.push("правка тем");
      if (waiting.length) {
        what.push(plural(waiting.length, "серия", "серии", "серии") + " " +
          waiting.map(Number).join(", "));
      }
      var w = el("div", "card");
      w.appendChild(el("div", "tblock-head", "Отправлено, ждём сайт"));
      w.appendChild(el("div", "summary",
        what.join(" и ") + " — уже в репозитории. GitHub Pages выкладывает " +
        "изменения примерно за минуту; после этого они появятся на сайте, " +
        "а здесь эта плашка исчезнет сама."));
      host.appendChild(w);
    }
  }

  /* Последовательная очередь: темы первыми, серии по возрастанию номера. */
  function runQueue(items) {
    if (state.busy || !TOKEN) return;
    var queue = items.slice().sort(function (a, b) {
      if (a.key === "types") return -1;
      if (b.key === "types") return 1;
      return a.n - b.n;
    });

    state.busy = true;
    state.note = "";
    state.noteKind = "";
    queue.forEach(function (it) { state.sending[it.key] = "в очереди…"; });
    render();

    var done = 0, failed = 0;

    function step() {
      if (!queue.length) {
        state.busy = false;
        if (failed) {
          state.note = "Отправлено " + done + ", не удалось " + failed +
            ". Неотправленное осталось в черновиках.";
          state.noteKind = "bad";
        } else {
          state.note = "Отправлено: " + done + ". Сайт обновится за минуту.";
          state.noteKind = "good";
        }
        return reload();
      }
      var it = queue.shift();
      state.sending[it.key] = "отправляю…";
      render();
      var job = it.key === "types" ? sendTypes() : sendSeries(it.n);
      return job.then(function () {
        done += 1;
        delete state.sending[it.key];
        return step();
      }, function (err) {
        failed += 1;
        state.sending[it.key] = "ошибка: " + err.message;
        return step();
      });
    }

    step();
  }

  function render() {
    var main = document.getElementById("main");
    clear(main);

    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
      t.setAttribute("aria-selected", t.dataset.view === state.view ? "true" : "false");
    });

    if (state.note && state.noteKind) {
      var banner = el("div", "banner " + state.noteKind);
      banner.appendChild(el("span", null, state.note));
      if (state.noteKind === "good") {
        var link = el("a", "banner-link", "открыть сайт");
        link.href = "index.html";
        banner.appendChild(link);
      }
      banner.appendChild(button("×", "banner-close", function () {
        state.note = "";
        state.noteKind = "";
        render();
      }));
      main.appendChild(banner);
    }

    if (state.view === "series") viewSeries(main);
    else if (state.view === "themes") viewThemes(main);
    else if (state.view === "send") viewSend(main);
    else if (state.view === "access") viewAccess(main);

    var badge = document.getElementById("tab-badge");
    var count = pendingItems().length;
    badge.hidden = !count;
    badge.textContent = count;
  }

  function setupChrome() {
    var r = repo();
    document.getElementById("brand-sub").textContent =
      (r.owner || "?") + "/" + (r.name || "?");

    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
      t.addEventListener("click", function () {
        state.view = t.dataset.view;
        state.note = "";
        render();
      });
    });

    window.addEventListener("beforeunload", function (e) {
      if (state.busy) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  // ── загрузка ────────────────────────────────────────────

  function loadFromFiles() {
    function get(path) {
      return fetch("data/" + path, { cache: "no-store" }).then(function (r) {
        if (!r.ok) throw new Error(path + ": " + r.status);
        return r.json();
      });
    }
    return Promise.all([
      get("config.json"), get("types.json"), get("students.json"), get("series/manifest.json")
    ]).then(function (res) {
      return Promise.all(res[3].series.map(function (f) { return get("series/" + f); }))
        .then(function (series) {
          series.sort(function (a, b) { return a.n - b.n; });
          return { config: res[0], types: res[1], students: res[2], series: series };
        });
    });
  }

  function reload() {
    return loadFromFiles().then(function (d) {
      DATA = d;
      pruneSent();
      if (state.draft && !DRAFTS[draftKey(state.draft.n)] && !seriesByNumber(state.draft.n)) {
        state.draft = null;
      }
      render();
    }).catch(function () { render(); });
  }

  document.addEventListener("DOMContentLoaded", function () {
    TOKEN = lsGet(LS_TOKEN, null);
    loadDrafts();
    loadSent();
    loadTypesDraft();
    loadFromFiles().then(function (d) {
      DATA = d;
      pruneSent();
      setupChrome();
      render();
    }).catch(function (err) {
      var main = document.getElementById("main");
      var box = el("div", "card");
      box.appendChild(el("div", "section-title", "Не удалось загрузить данные"));
      box.appendChild(el("div", "summary", String(err.message || err)));
      box.appendChild(el("div", "foot",
        "Редактор берёт данные с того же сайта. Открой его по ссылке вида " +
        "https://ник.github.io/репозиторий/edit.html — с диска он работать не будет."));
      main.appendChild(box);
    });
  });
})();
