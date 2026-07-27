/* Кондуит — редактор. Работает в браузере телефона, без сервера.

   Схема простая: правишь на экране — жмёшь «Сохранить» — изменение уходит в
   репозиторий, публичный сайт обновляется сам примерно за минуту. Ничего между
   этим не копится: несохранённое живёт только пока открыта страница.

   Токен лежит в localStorage этого браузера и уходит единственному адресату —
   api.github.com. */

(function () {
  "use strict";

  var DATA = null;      // {config, types, students, series}
  var TOKEN = null;
  var SENT = {};        // "01" -> когда сохранено; сайт обновляется не мгновенно

  var state = {
    view: "series",
    series: null,       // открытая серия {n, date, problems, solved}
    isNew: false,
    dirty: false,
    graves: null,       // правка гробария, пока не сохранена
    typesEdit: null,    // правка тем, пока не сохранена
    busy: false,
    note: "",
    noteKind: "",       // good | bad | ""
    confirmSub: null,
    confirmDelete: false,
    pickTheme: null,    // id задачи, у которой открыт выбор темы
    pickDate: false
  };

  var LS_TOKEN = "conduit-token";
  var LS_SENT = "conduit-sent";
  var LETTERS = "абвгде";

  var MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  var MONTHS_NOM = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
    "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  var MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн",
    "июл", "авг", "сен", "окт", "ноя", "дек"];
  var WEEKDAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
  var WEEKDAYS_FULL = ["понедельник", "вторник", "среда", "четверг",
    "пятница", "суббота", "воскресенье"];

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

  function parseISO(iso) {
    var p = String(iso).split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function toISO(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function shortDate(iso) {
    var p = String(iso).split("-");
    if (p.length !== 3) return iso;
    return Number(p[2]) + " " + MONTHS_SHORT[Number(p[1]) - 1];
  }

  function longDate(iso) {
    var d = parseISO(iso);
    var wd = (d.getDay() + 6) % 7;
    return d.getDate() + " " + MONTHS[d.getMonth()] + ", " + WEEKDAYS_FULL[wd];
  }

  function todayISO() { return toISO(new Date()); }

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

  function repo() { return (DATA && DATA.config.repo) || {}; }

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
          if (res.status === 401) msg = "токен не принят — проверь, не истёк ли он";
          if (res.status === 403) msg = "нет прав — нужен доступ Contents: Read and write";
          if (res.status === 404) msg = "не найдено — проверь ник, имя репозитория и права токена";
          if (res.status === 409) msg = "файл изменился на сервере — обнови страницу и повтори";
          throw new Error(msg);
        }
        return j;
      });
    }, function () {
      throw new Error("нет связи с GitHub");
    });
  }

  function getFile(path) {
    return api("/contents/" + path + "?ref=" + (repo().branch || "main"))
      .then(function (j) { return { sha: j.sha, text: utf8FromB64(j.content) }; })
      .catch(function (e) {
        if (/не найдено/.test(e.message)) return null;
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

  // ── серии ───────────────────────────────────────────────

  function loadSent() {
    try { SENT = JSON.parse(lsGet(LS_SENT, "{}")) || {}; } catch (e) { SENT = {}; }
  }

  /* Сайт переразворачивается не мгновенно, поэтому только что сохранённая серия
     ещё минуту не видна в данных. Помним такие номера, иначе «+ новая» предложит
     занятый номер и следующая серия затрёт предыдущую. */
  function markSent(n) {
    SENT[pad2(n)] = new Date().toISOString();
    lsSet(LS_SENT, JSON.stringify(SENT));
  }

  function pruneSent() {
    var changed = false;
    Object.keys(SENT).forEach(function (k) {
      if (seriesByNumber(Number(k))) { delete SENT[k]; changed = true; }
    });
    if (changed) lsSet(LS_SENT, JSON.stringify(SENT));
  }

  function seriesByNumber(n) {
    return DATA.series.filter(function (s) { return s.n === n; })[0] || null;
  }

  function nextNumber() {
    var max = 0;
    DATA.series.forEach(function (s) { if (s.n > max) max = s.n; });
    Object.keys(SENT).forEach(function (k) { if (Number(k) > max) max = Number(k); });
    return max + 1;
  }

  function openSeries(n) {
    if (!confirmLeave()) return;
    var s = seriesByNumber(n);
    state.isNew = !s;
    if (s) {
      state.series = JSON.parse(JSON.stringify({
        n: s.n, date: s.date, problems: s.problems, solved: s.solved
      }));
      DATA.students.forEach(function (st) {
        if (!state.series.solved[st.id]) state.series.solved[st.id] = [];
      });
    } else {
      var solved = {};
      DATA.students.forEach(function (st) { solved[st.id] = []; });
      state.series = { n: n, date: todayISO(), problems: [], solved: solved };
    }
    state.dirty = false;
    state.note = "";
    state.noteKind = "";
    state.pickTheme = null;
    state.pickDate = false;
    state.confirmDelete = false;
    render();
  }

  function confirmLeave() {
    if (!state.dirty) return true;
    return window.confirm("Есть несохранённые изменения. Уйти и потерять их?");
  }

  function touch() {
    state.dirty = true;
    state.note = "";
    state.noteKind = "";
  }

  function solvedCount(pid) {
    var c = 0;
    DATA.students.forEach(function (s) {
      var list = state.series.solved[s.id];
      if (list && list.indexOf(pid) !== -1) c += 1;
    });
    return c;
  }

  function totalPluses() {
    return DATA.students.reduce(function (a, s) {
      return a + ((state.series.solved[s.id] || []).length);
    }, 0);
  }

  function renameProblem(oldId, newId) {
    state.series.problems.forEach(function (p) { if (p.id === oldId) p.id = newId; });
    Object.keys(state.series.solved).forEach(function (sid) {
      var list = state.series.solved[sid];
      var i = list.indexOf(oldId);
      if (i !== -1) list[i] = newId;
    });
  }

  function removeProblem(pid) {
    state.series.problems = state.series.problems.filter(function (p) { return p.id !== pid; });
    Object.keys(state.series.solved).forEach(function (sid) {
      state.series.solved[sid] = state.series.solved[sid].filter(function (x) { return x !== pid; });
    });
  }

  function numPrefix(id) {
    var m = String(id).match(/^(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  function addProblem() {
    var max = 0;
    state.series.problems.forEach(function (p) {
      var n = numPrefix(p.id);
      if (n > max) max = n;
    });
    var first = types()[0];
    state.series.problems.push({
      id: String(max + 1),
      type: first.id,
      sub: first.subs && first.subs.length ? first.subs[0].id : null
    });
    touch();
  }

  /* Упражнение — не тема, а вид задания: идёт под нулевым номером, тоже может
     иметь пункты и на сайте фильтруется отдельно от тем. */
  function addExercise() {
    var ps = state.series.problems;
    var first = types()[0];
    var family = ps.filter(function (p) { return numPrefix(p.id) === 0; });

    if (!family.length) {
      ps.unshift({
        id: "0",
        type: first.id,
        sub: first.subs && first.subs.length ? first.subs[0].id : null,
        exercise: true
      });
    } else {
      var sample = family[family.length - 1];
      if (family.length === 1 && String(sample.id) === "0") {
        renameProblem("0", "0" + LETTERS[0]);
        insertAfter(sample, {
          id: "0" + LETTERS[1], type: sample.type, sub: sample.sub, exercise: true
        });
      } else {
        var letter = LETTERS[family.length] || LETTERS[LETTERS.length - 1];
        insertAfter(sample, {
          id: "0" + letter, type: sample.type, sub: sample.sub, exercise: true
        });
      }
    }
    touch();
  }

  function addPart() {
    var ps = state.series.problems;
    if (!ps.length) return addProblem();
    var lastNum = numPrefix(ps[ps.length - 1].id);
    var family = ps.filter(function (p) { return numPrefix(p.id) === lastNum; });
    var sample = family[family.length - 1];

    if (family.length === 1 && String(sample.id) === String(lastNum)) {
      renameProblem(sample.id, lastNum + LETTERS[0]);
      insertAfter(sample, { id: lastNum + LETTERS[1], type: sample.type, sub: sample.sub });
    } else {
      var letter = LETTERS[family.length] || LETTERS[LETTERS.length - 1];
      insertAfter(sample, { id: lastNum + letter, type: sample.type, sub: sample.sub });
    }
    touch();
  }

  function insertAfter(anchor, item) {
    var i = state.series.problems.indexOf(anchor);
    state.series.problems.splice(i === -1 ? state.series.problems.length : i + 1, 0, item);
  }

  function validate() {
    var d = state.series;
    if (!d) return "нечего сохранять";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return "не указана дата";
    if (!d.problems.length) return "не добавлено ни одной задачи";
    var seen = {};
    for (var i = 0; i < d.problems.length; i++) {
      var p = d.problems[i];
      var id = String(p.id).trim();
      if (!id) return "у задачи пустой номер";
      if (seen[id]) return "номер «" + id + "» встречается дважды";
      seen[id] = true;
      if (!p.type) return "у задачи " + id + " не выбрана тема";
    }
    return null;
  }

  function cmpIds(a, b) {
    return numPrefix(a) - numPrefix(b) || String(a).localeCompare(String(b), "ru");
  }

  function saveSeries() {
    if (state.busy) return;
    if (!TOKEN) return needToken();
    var problem = validate();
    if (problem) {
      state.note = "Не сохранено: " + problem;
      state.noteKind = "bad";
      return render();
    }

    var d = state.series;
    var file = "data/series/" + pad2(d.n) + ".json";
    var payload = {
      n: d.n,
      date: d.date,
      title: "Серия " + d.n,
      problems: d.problems.map(function (p) {
        return {
          id: String(p.id).trim(),
          type: p.type,
          sub: p.sub || null,
          exercise: !!p.exercise
        };
      }),
      solved: {}
    };
    DATA.students.forEach(function (s) {
      payload.solved[s.id] = (d.solved[s.id] || []).slice().sort(cmpIds);
    });
    var pluses = totalPluses();

    state.busy = true;
    state.note = "";
    state.noteKind = "";
    render();

    getFile(file)
      .then(function (cur) {
        return putFile(file, JSON.stringify(payload, null, 2) + "\n",
          "Серия " + d.n + " (" + shortDate(d.date) + "): " +
          withNum(payload.problems.length, "задача", "задачи", "задач") + ", " +
          withNum(pluses, "плюс", "плюса", "плюсов"),
          cur && cur.sha);
      })
      .then(function () { return ensureManifest(pad2(d.n) + ".json"); })
      .then(function () {
        markSent(d.n);
        state.busy = false;
        state.dirty = false;
        state.note = "Сохранено";
        state.noteKind = "good";
        return reload();
      })
      .catch(function (err) {
        state.busy = false;
        state.note = "Не сохранилось: " + err.message;
        state.noteKind = "bad";
        render();
      });
  }

  /* Удаление серии: файл и строка в списке серий. */
  function deleteSeries() {
    if (state.busy || !state.series) return;
    if (!TOKEN) return needToken();

    var n = state.series.n;
    var name = pad2(n) + ".json";
    var file = "data/series/" + name;

    state.busy = true;
    state.note = "";
    state.noteKind = "";
    render();

    getFile(file)
      .then(function (cur) {
        if (!cur) return null;
        return api("/contents/" + file, {
          method: "DELETE",
          body: JSON.stringify({
            message: "Серия " + n + " удалена",
            sha: cur.sha,
            branch: repo().branch || "main"
          })
        });
      })
      .then(function () { return dropFromManifest(name); })
      .then(function () {
        delete SENT[pad2(n)];
        lsSet(LS_SENT, JSON.stringify(SENT));
        state.busy = false;
        state.series = null;
        state.dirty = false;
        state.confirmDelete = false;
        state.note = "Серия " + n + " удалена";
        state.noteKind = "good";
        return reload();
      })
      .catch(function (err) {
        state.busy = false;
        state.note = "Не удалилось: " + err.message;
        state.noteKind = "bad";
        render();
      });
  }

  function dropFromManifest(name) {
    var path = "data/series/manifest.json";
    return getFile(path).then(function (cur) {
      if (!cur) return null;
      var list = [];
      try { list = (JSON.parse(cur.text).series || []).slice(); } catch (e) { list = []; }
      var next = list.filter(function (f) { return f !== name; });
      if (next.length === list.length) return null;
      return putFile(path, JSON.stringify({ series: next }, null, 2) + "\n",
        "Список серий: убрана " + name, cur.sha);
    });
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

  function needToken() {
    state.view = "access";
    state.note = "Нужен токен";
    state.noteKind = "bad";
    render();
  }

  // ── гробарий ────────────────────────────────────────────

  /* Гробы живут отдельным файлом: они не привязаны ко дню, копятся всю смену
     и на сайте включаются в рейтинг отдельным переключателем. Номер всегда
     «Гn» — поэтому он не редактируется, а выдаётся следующим свободным. */

  function ensureGraves() {
    if (!state.graves) {
      state.graves = JSON.parse(JSON.stringify(DATA.graves));
    }
    DATA.students.forEach(function (s) {
      if (!state.graves.solved[s.id]) state.graves.solved[s.id] = [];
    });
    return state.graves;
  }

  function graveNum(id) {
    var m = String(id).match(/(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  function cmpGraves(a, b) { return graveNum(a) - graveNum(b); }

  function gravesPayload(g) {
    var solved = {};
    DATA.students.forEach(function (s) {
      solved[s.id] = (((g && g.solved) || {})[s.id] || []).slice().sort(cmpGraves);
    });
    return {
      problems: (((g && g.problems) || [])).map(function (p) {
        return { id: p.id, type: p.type, sub: p.sub || null };
      }),
      solved: solved
    };
  }

  function gravesDirty() {
    return !!state.graves &&
      JSON.stringify(gravesPayload(state.graves)) !==
      JSON.stringify(gravesPayload(DATA.graves));
  }

  function touchGraves() {
    state.note = "";
    state.noteKind = "";
  }

  function addGrave() {
    var g = ensureGraves();
    var max = 0;
    g.problems.forEach(function (p) {
      var n = graveNum(p.id);
      if (n > max) max = n;
    });
    var first = types()[0];
    g.problems.push({
      id: "Г" + (max + 1),
      type: first.id,
      sub: first.subs && first.subs.length ? first.subs[0].id : null
    });
    touchGraves();
  }

  function removeGrave(id) {
    var g = ensureGraves();
    g.problems = g.problems.filter(function (p) { return p.id !== id; });
    Object.keys(g.solved).forEach(function (sid) {
      g.solved[sid] = g.solved[sid].filter(function (x) { return x !== id; });
    });
    touchGraves();
  }

  function graveSolvers() {
    var g = ensureGraves();
    return DATA.students.reduce(function (a, s) {
      return a + (g.solved[s.id] || []).length;
    }, 0);
  }

  function saveGraves() {
    if (state.busy) return;
    if (!TOKEN) return needToken();
    if (!gravesDirty()) return;

    var payload = gravesPayload(state.graves);
    var pluses = graveSolvers();

    state.busy = true;
    state.note = "";
    state.noteKind = "";
    render();

    getFile("data/graves.json")
      .then(function (cur) {
        return putFile("data/graves.json", JSON.stringify(payload, null, 2) + "\n",
          "Гробарий: " + withNum(payload.problems.length, "гроб", "гроба", "гробов") +
          ", " + withNum(pluses, "плюс", "плюса", "плюсов"),
          cur && cur.sha);
      })
      .then(function () {
        state.busy = false;
        state.note = "Сохранено";
        state.noteKind = "good";
        return reload();
      })
      .catch(function (err) {
        state.busy = false;
        state.note = "Не сохранилось: " + err.message;
        state.noteKind = "bad";
        render();
      });
  }

  function viewGraves(host) {
    var g = ensureGraves();

    var card = el("div", "card");
    g.problems.forEach(function (p) { card.appendChild(graveRow(p)); });

    var actions = el("div", "frow gap");
    actions.appendChild(button("+ гроб", "ghost-btn", function () {
      addGrave();
      render();
    }));
    card.appendChild(actions);
    host.appendChild(card);

    if (g.problems.length) {
      var sh = el("div", "section-head");
      sh.appendChild(el("span", "section-title", "Кто решил"));
      host.appendChild(sh);
      host.appendChild(conduitGrid(g.problems, g.solved, function () {
        touchGraves();
        refreshSaveCard();
      }));
    }

    var save = el("div", "card savecard");
    save.appendChild(el("div", "savecard-main"));
    var b = button(state.busy ? "…" : "Сохранить", "primary-btn", saveGraves);
    b.disabled = state.busy || !gravesDirty();
    save.appendChild(b);
    host.appendChild(save);
  }

  function graveRow(p) {
    var wrap = el("div", "prow-wrap");
    var row = el("div", "prow");

    row.appendChild(el("span", "grave-id", p.id));

    var t = typeById(p.type);
    var sub = t && (t.subs || []).filter(function (s) { return s.id === p.sub; })[0];
    var open = state.pickTheme === p.id;

    var pick = el("button", "picker-btn" + (open ? " open" : ""));
    pick.type = "button";
    var label = el("span", "picker-label");
    label.appendChild(dot(t ? t.slot : 1));
    label.appendChild(document.createTextNode(
      (t ? t.name : "тема?") + (sub ? " · " + sub.name : "")));
    pick.appendChild(label);
    pick.appendChild(el("span", "picker-caret", "▾"));
    pick.addEventListener("click", function () {
      state.pickTheme = open ? null : p.id;
      render();
    });
    row.appendChild(pick);

    row.appendChild(button("×", "icon-btn", function () {
      removeGrave(p.id);
      render();
    }));

    wrap.appendChild(row);
    if (open) wrap.appendChild(themeChooser(p, false, touchGraves));
    return wrap;
  }

  // ── темы ────────────────────────────────────────────────

  function types() { return state.typesEdit || (DATA ? DATA.types : []); }

  function typeById(id) {
    return types().filter(function (t) { return t.id === id; })[0] || null;
  }

  function editTypes() {
    if (!state.typesEdit) state.typesEdit = JSON.parse(JSON.stringify(DATA.types));
    return state.typesEdit;
  }

  function typesDirty() {
    return !!state.typesEdit &&
      JSON.stringify(state.typesEdit) !== JSON.stringify(DATA.types);
  }

  function subUsage(catId, subId) {
    var n = 0;
    DATA.series.forEach(function (s) {
      (s.problems || []).forEach(function (p) {
        if (p.type === catId && (p.sub || null) === subId) n += 1;
      });
    });
    if (state.series) {
      state.series.problems.forEach(function (p) {
        if (p.type === catId && (p.sub || null) === subId) n += 1;
      });
    }
    return n;
  }

  function saveTypes() {
    if (state.busy) return;
    if (!TOKEN) return needToken();
    if (!typesDirty()) return;

    state.busy = true;
    state.note = "";
    state.noteKind = "";
    render();

    var payload = state.typesEdit;
    getFile("data/types.json")
      .then(function (cur) {
        return putFile("data/types.json", JSON.stringify(payload, null, 2) + "\n",
          "Темы обновлены", cur && cur.sha);
      })
      .then(function () {
        state.busy = false;
        state.note = "Сохранено";
        state.noteKind = "good";
        return reload();
      })
      .catch(function (err) {
        state.busy = false;
        state.note = "Не сохранилось: " + err.message;
        state.noteKind = "bad";
        render();
      });
  }

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
    return out.replace(/-+/g, "-").replace(/^-|-$/g, "") || "tema";
  }

  function uniqueId(base, taken) {
    var id = base, i = 2;
    while (taken.indexOf(id) !== -1) { id = base + "-" + i; i += 1; }
    return id;
  }

  // ── детали интерфейса ───────────────────────────────────

  function dot(slot) {
    var d = el("span", "dot");
    d.style.background = "var(--s" + slot + ")";
    return d;
  }

  function button(text, cls, fn) {
    var b = el("button", cls || "ghost-btn", text);
    b.type = "button";
    b.addEventListener("click", fn);
    return b;
  }

  function field(label, node) {
    var f = el("div", "field");
    f.appendChild(el("span", "field-label", label));
    f.appendChild(node);
    return f;
  }

  /* Свой выбор даты вместо системного: у мобильных браузеров он выглядит
     по-разному и всегда чужеродно. */
  function dateField() {
    var box = el("div", "datefield");

    var btn = el("button", "picker-btn" + (state.pickDate ? " open" : ""));
    btn.type = "button";
    btn.appendChild(el("span", null, longDate(state.series.date)));
    btn.appendChild(el("span", "picker-caret", "▾"));
    btn.addEventListener("click", function () {
      state.pickDate = !state.pickDate;
      state.pickTheme = null;
      render();
    });
    box.appendChild(btn);

    if (state.pickDate) box.appendChild(calendar());
    return box;
  }

  function calendar() {
    var cur = parseISO(state.series.date);
    var shown = state.calMonth ? parseISO(state.calMonth + "-01")
      : new Date(cur.getFullYear(), cur.getMonth(), 1);

    var wrap = el("div", "calendar");

    var head = el("div", "cal-head");
    head.appendChild(button("‹", "cal-nav", function () {
      var m = new Date(shown.getFullYear(), shown.getMonth() - 1, 1);
      state.calMonth = m.getFullYear() + "-" + pad2(m.getMonth() + 1);
      render();
    }));
    head.appendChild(el("span", "cal-title",
      MONTHS_NOM[shown.getMonth()] + " " + shown.getFullYear()));
    head.appendChild(button("›", "cal-nav", function () {
      var m = new Date(shown.getFullYear(), shown.getMonth() + 1, 1);
      state.calMonth = m.getFullYear() + "-" + pad2(m.getMonth() + 1);
      render();
    }));
    wrap.appendChild(head);

    var grid = el("div", "cal-grid");
    WEEKDAYS.forEach(function (w) { grid.appendChild(el("span", "cal-wd", w)); });

    var first = new Date(shown.getFullYear(), shown.getMonth(), 1);
    var offset = (first.getDay() + 6) % 7;
    var days = new Date(shown.getFullYear(), shown.getMonth() + 1, 0).getDate();
    var today = todayISO();

    for (var i = 0; i < offset; i++) grid.appendChild(el("span", "cal-empty"));
    for (var d = 1; d <= days; d++) {
      (function (day) {
        var iso = toISO(new Date(shown.getFullYear(), shown.getMonth(), day));
        var b = el("button", "cal-day" +
          (iso === state.series.date ? " sel" : "") +
          (iso === today ? " today" : ""), day);
        b.type = "button";
        b.addEventListener("click", function () {
          state.series.date = iso;
          state.pickDate = false;
          state.calMonth = null;
          touch();
          render();
        });
        grid.appendChild(b);
      })(d);
    }
    wrap.appendChild(grid);

    var foot = el("div", "cal-foot");
    foot.appendChild(button("сегодня", "mini-btn", function () {
      state.series.date = todayISO();
      state.pickDate = false;
      state.calMonth = null;
      touch();
      render();
    }));
    foot.appendChild(button("закрыть", "mini-btn", function () {
      state.pickDate = false;
      render();
    }));
    wrap.appendChild(foot);

    return wrap;
  }

  // ── вид: серия ──────────────────────────────────────────

  var lastSeriesN = null;

  function viewSeries(host) {
    var picker = el("div", "card");
    var head = el("div", "filter-head");
    head.appendChild(el("span", "filter-title", "Какую серию правим"));
    picker.appendChild(head);

    var chips = el("div", "chips");
    DATA.series.forEach(function (s) {
      chips.appendChild(dayChip(s.n, shortDate(s.date), false, s.n));
    });
    Object.keys(SENT).sort().forEach(function (k) {
      var n = Number(k);
      if (seriesByNumber(n)) return;
      chips.appendChild(dayChip(n, "ждём", true, n));
    });

    var add = el("button", "chip day new");
    add.type = "button";
    add.setAttribute("aria-pressed", "false");
    add.appendChild(el("b", null, "+"));
    add.appendChild(el("small", null, "новая"));
    add.addEventListener("click", function () { openSeries(nextNumber()); });
    chips.appendChild(add);

    picker.appendChild(chips);
    host.appendChild(picker);

    if (!state.series) { lastSeriesN = null; return; }

    // оживает только при переходе на другую серию, а не на каждую правку
    var body = el("div", "series-body" +
      (state.series.n === lastSeriesN ? "" : " view-enter"));
    lastSeriesN = state.series.n;
    host.appendChild(body);
    host = body;

    // шапка серии
    var meta = el("div", "card");
    var mrow = el("div", "frow top");

    var numInput = el("input");
    numInput.type = "number";
    numInput.inputMode = "numeric";
    numInput.min = "1";
    numInput.value = state.series.n;
    numInput.className = "input short";
    numInput.addEventListener("change", function () {
      var v = parseInt(numInput.value, 10);
      if (!v || v < 1) { numInput.value = state.series.n; return; }
      state.series.n = v;
      state.isNew = !seriesByNumber(v);
      touch();
      render();
    });
    mrow.appendChild(field("Номер серии", numInput));
    mrow.appendChild(field("Дата", dateField()));
    meta.appendChild(mrow);

    host.appendChild(meta);

    // задачи
    var sh = el("div", "section-head");
    sh.appendChild(el("span", "section-title", "Задачи"));
    host.appendChild(sh);

    var pcard = el("div", "card");
    state.series.problems.forEach(function (p) { pcard.appendChild(problemRow(p)); });

    var actions = el("div", "frow gap");
    actions.appendChild(button("+ задача", "ghost-btn", function () { addProblem(); render(); }));
    actions.appendChild(button("+ пункт", "ghost-btn", function () { addPart(); render(); }));
    actions.appendChild(button("+ упражнение", "ghost-btn", function () { addExercise(); render(); }));
    pcard.appendChild(actions);
    host.appendChild(pcard);

    if (state.series.problems.length) {
      var sh2 = el("div", "section-head");
      sh2.appendChild(el("span", "section-title", "Кондуит"));
      host.appendChild(sh2);
      host.appendChild(conduitGrid(state.series.problems, state.series.solved,
        function () {
          touch();
          refreshSaveCard();
        }));
    }

    host.appendChild(saveBar());
    if (!state.isNew) host.appendChild(deleteBar());
  }

  function dayChip(n, label, waiting, open) {
    var b = el("button", "chip day" + (waiting ? " pending" : ""));
    b.type = "button";
    b.setAttribute("aria-pressed",
      state.series && state.series.n === n ? "true" : "false");
    b.appendChild(el("b", null, n));
    b.appendChild(el("small", null, label));
    b.addEventListener("click", function () {
      if (waiting) {
        state.note = "Серия " + n + " сохранена";
        state.noteKind = "good";
        return render();
      }
      openSeries(open);
    });
    return b;
  }

  /* Из карточки убрано всё, кроме кнопки: состояние видно по самой кнопке.
     Остаётся только то, что мешает сохранить — иначе кнопка гаснет молча. */
  function saveBar() {
    var problem = validate();
    var card = el("div", "card savecard");

    var left = el("div", "savecard-main");
    if (problem) left.appendChild(el("div", "savecard-title", problem));
    card.appendChild(left);

    var b = button(state.busy ? "…" : "Сохранить", "primary-btn", saveSeries);
    b.disabled = state.busy || !!problem || !state.dirty;
    card.appendChild(b);

    return card;
  }

  function deleteBar() {
    var card = el("div", "card savecard");
    var left = el("div", "savecard-main");

    if (state.confirmDelete) {
      left.appendChild(el("div", "savecard-title",
        "Удалить серию " + state.series.n + " вместе со всеми плюсами?"));
      card.appendChild(left);
      var yes = button(state.busy ? "…" : "Удалить", "primary-btn danger", deleteSeries);
      yes.disabled = state.busy;
      card.appendChild(yes);
      card.appendChild(button("Отмена", "ghost-btn", function () {
        state.confirmDelete = false;
        render();
      }));
    } else {
      card.appendChild(left);
      card.appendChild(button("Удалить серию", "primary-btn danger", function () {
        state.confirmDelete = true;
        render();
      }));
    }
    return card;
  }

  function problemRow(p) {
    var wrap = el("div", "prow-wrap");
    var row = el("div", "prow");

    var idIn = el("input");
    idIn.className = "input tiny";
    idIn.value = p.id;
    idIn.addEventListener("change", function () {
      var v = String(idIn.value).trim();
      if (!v) { idIn.value = p.id; return; }
      renameProblem(p.id, v);
      touch();
      render();
    });
    row.appendChild(idIn);

    var t = typeById(p.type);
    var sub = t && (t.subs || []).filter(function (s) { return s.id === p.sub; })[0];
    var open = state.pickTheme === p.id;

    var pick = el("button", "picker-btn" + (open ? " open" : ""));
    pick.type = "button";
    var label = el("span", "picker-label");
    label.appendChild(dot(t ? t.slot : 1));
    if (p.exercise) label.appendChild(el("span", "badge", "упр."));
    label.appendChild(document.createTextNode(
      (t ? t.name : "тема?") + (sub ? " · " + sub.name : "")));
    pick.appendChild(label);
    pick.appendChild(el("span", "picker-caret", "▾"));
    pick.addEventListener("click", function () {
      state.pickTheme = open ? null : p.id;
      state.pickDate = false;
      render();
    });
    row.appendChild(pick);

    row.appendChild(button("×", "icon-btn", function () {
      removeProblem(p.id);
      touch();
      render();
    }));

    wrap.appendChild(row);
    if (open) wrap.appendChild(themeChooser(p, true, touch));
    return wrap;
  }

  /* Один и тот же выбор темы для задачи серии и для гроба. У гроба нет выбора
     «задача или упражнение», и правка помечает другой файл — отсюда два
     параметра. */
  function themeChooser(p, withKind, touch) {
    var box = el("div", "chooser");

    if (withKind) {
      // вид задания — признак, не связанный с темой
      var kinds = el("div", "chips");
      [[false, "Задача"], [true, "Упражнение"]].forEach(function (pair) {
        var b = el("button", "chip pick", pair[1]);
        b.type = "button";
        b.setAttribute("aria-pressed", !!p.exercise === pair[0] ? "true" : "false");
        b.addEventListener("click", function () {
          p.exercise = pair[0];
          touch();
          render();
        });
        kinds.appendChild(b);
      });
      box.appendChild(kinds);
      box.appendChild(el("div", "chooser-sep"));
    }

    var cats = el("div", "chips");
    types().forEach(function (t) {
      var b = el("button", "chip pick");
      b.type = "button";
      b.setAttribute("aria-pressed", t.id === p.type ? "true" : "false");
      b.appendChild(dot(t.slot));
      b.appendChild(document.createTextNode(t.name));
      b.addEventListener("click", function () {
        p.type = t.id;
        p.sub = t.subs && t.subs.length ? t.subs[0].id : null;
        touch();
        render();
      });
      cats.appendChild(b);
    });
    box.appendChild(cats);

    var t = typeById(p.type);
    if (t && (t.subs || []).length) {
      var subs = el("div", "chips subs-row");
      t.subs.forEach(function (s) {
        var b = el("button", "chip sub pick");
        b.type = "button";
        b.style.setProperty("--accent", "var(--s" + t.slot + ")");
        b.setAttribute("aria-pressed", s.id === p.sub ? "true" : "false");
        b.appendChild(document.createTextNode(s.name));
        b.addEventListener("click", function () {
          p.sub = s.id;
          state.pickTheme = null;
          touch();
          render();
        });
        subs.appendChild(b);
      });
      var none = el("button", "chip sub pick");
      none.type = "button";
      none.style.setProperty("--accent", "var(--s" + t.slot + ")");
      none.setAttribute("aria-pressed", p.sub ? "false" : "true");
      none.appendChild(document.createTextNode("без уточнения"));
      none.addEventListener("click", function () {
        p.sub = null;
        state.pickTheme = null;
        touch();
        render();
      });
      subs.appendChild(none);
      box.appendChild(subs);
    }

    return box;
  }

  /* Как и на сайте: фамилии — отдельной таблицей слева, клетки прокручиваются
     справа. Залипающий столбец на телефоне налезал на имена.

     Сетка одна на серию и на гробарий: ей передают список задач, отметки и
     что сделать после касания. Подписи она пересчитывает сама, не перерисовывая
     таблицу — иначе на каждом плюсе сбивалась бы прокрутка. */
  function conduitGrid(problems, solved, onChange) {
    var leader = leaderId();
    var split = el("div", "conduit-split");

    function marked(sid, pid) {
      var list = solved[sid];
      return !!list && list.indexOf(pid) !== -1;
    }

    function rowCount(sid) { return (solved[sid] || []).length; }

    function colCount(pid) {
      return DATA.students.filter(function (s) { return marked(s.id, pid); }).length;
    }

    function allCount() {
      return DATA.students.reduce(function (a, s) { return a + rowCount(s.id); }, 0);
    }

    var names = el("table", "conduit names");
    var nHead = el("thead");
    var nhr = el("tr");
    nhr.appendChild(el("th", "pname", "Ученик"));
    nHead.appendChild(nhr);
    names.appendChild(nHead);

    var nBody = el("tbody");
    DATA.students.forEach(function (st) {
      var tr = el("tr", "crow");
      tr.appendChild(el("td", "pname" +
        (DATA.config.admin === st.id ? " admin" : "") +
        (leader === st.id ? " leader" : ""), st.name));
      nBody.appendChild(tr);
    });
    names.appendChild(nBody);

    var nFoot = el("tfoot");
    var nf1 = el("tr");
    nf1.appendChild(el("td", "pname", "решили"));
    nFoot.appendChild(nf1);
    var nf2 = el("tr", "weights");
    nf2.appendChild(el("td", "pname", "вес"));
    nFoot.appendChild(nf2);
    names.appendChild(nFoot);
    split.appendChild(names);

    var scroll = el("div", "conduit-scroll");
    var table = el("table", "conduit cells edit");

    var thead = el("thead");
    var hr = el("tr");
    problems.forEach(function (p) {
      var t = typeById(p.type);
      var cell = el("th");
      var box = el("div", "phead");
      box.appendChild(el("div", "phead-id" + (p.exercise ? " ex" : ""), p.id));
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
      problems.forEach(function (p) {
        var td = el("td", "cell");
        var isOn = marked(st.id, p.id);
        var b = el("button", "mark" + (isOn ? " on" : ""), isOn ? "+" : "");
        b.type = "button";
        b.setAttribute("aria-label", st.name + ", " + p.id);
        b.addEventListener("click", function () {
          var list = solved[st.id] || (solved[st.id] = []);
          var i = list.indexOf(p.id);
          if (i === -1) list.push(p.id); else list.splice(i, 1);

          var on = i === -1;
          b.className = "mark" + (on ? " on pop" : "");
          b.textContent = on ? "+" : "";
          if (on) setTimeout(function () { b.classList.remove("pop"); }, 240);
          refresh();
        });
        td.appendChild(b);
        tr.appendChild(td);
      });
      tr.appendChild(el("td", "pcount rowcount", rowCount(st.id)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    var tfoot = el("tfoot");
    var f1 = el("tr");
    problems.forEach(function (p) { f1.appendChild(el("td", "colcount", colCount(p.id))); });
    f1.appendChild(el("td", "pcount total", allCount()));
    tfoot.appendChild(f1);
    var f2 = el("tr", "weights");
    problems.forEach(function (p) {
      f2.appendChild(el("td", "colweight", DATA.config.students_total - colCount(p.id)));
    });
    f2.appendChild(el("td", "pcount"));
    tfoot.appendChild(f2);
    table.appendChild(tfoot);

    scroll.appendChild(table);
    split.appendChild(scroll);

    function refresh() {
      var rows = table.querySelectorAll("tbody tr");
      DATA.students.forEach(function (st, i) {
        var c = rows[i] && rows[i].querySelector(".rowcount");
        if (c) c.textContent = rowCount(st.id);
      });

      var cols = table.querySelectorAll(".colcount");
      var ws = table.querySelectorAll(".colweight");
      problems.forEach(function (p, i) {
        var n = colCount(p.id);
        if (cols[i]) cols[i].textContent = n;
        if (ws[i]) ws[i].textContent = DATA.config.students_total - n;
      });
      var total = table.querySelector(".total");
      if (total) total.textContent = allCount();
      if (onChange) onChange();
    }

    return split;
  }

  /* Лидер смены — по всем сериям, которые уже на сайте, так же как на публичной
     странице. Открытая правка сюда не входит: иначе метка прыгала бы на каждый
     поставленный плюс. */
  function leaderId() {
    var score = {};
    DATA.students.forEach(function (s) { score[s.id] = 0; });
    DATA.series.forEach(function (s) {
      (s.problems || []).forEach(function (p) {
        var solvers = DATA.students.filter(function (st) {
          var list = s.solved[st.id];
          return list && list.indexOf(p.id) !== -1;
        });
        var weight = DATA.config.students_total - solvers.length;
        solvers.forEach(function (st) { score[st.id] += weight; });
      });
    });
    var best = null;
    Object.keys(score).forEach(function (id) {
      if (score[id] > 0 && (!best || score[id] > score[best])) best = id;
    });
    return best;
  }

  /* Кнопку сохранения обновляем на месте: перерисовать экран нельзя, иначе на
     каждом касании сбивалась бы прокрутка кондуита. */
  function refreshSaveCard() {
    var card = document.querySelector(".savecard");
    if (!card) return;
    var b = card.querySelector(".primary-btn");

    if (state.view === "graves") {
      if (b) b.disabled = state.busy || !gravesDirty();
      return;
    }

    var problem = validate();
    var left = card.querySelector(".savecard-main");
    if (left) {
      clear(left);
      if (problem) left.appendChild(el("div", "savecard-title", problem));
    }
    if (b) b.disabled = state.busy || !!problem || !state.dirty;
  }

  // ── вид: темы ───────────────────────────────────────────

  function viewThemes(host) {
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
        var key = t.id + "/" + s.id;
        var line = el("div", "subline");
        line.appendChild(el("span", "subline-name", s.name));

        if (state.confirmSub === key) {
          var used = subUsage(t.id, s.id);
          var box = el("span", "confirm");
          box.appendChild(el("span", "confirm-text",
            used ? "стоит у " + withNum(used, "задачи", "задач", "задач") + ". Удалить?"
              : "удалить?"));
          box.appendChild(button("да", "mini-btn danger", function () {
            var draft = editTypes();
            var cat = draft.filter(function (x) { return x.id === t.id; })[0];
            cat.subs = cat.subs.filter(function (x) { return x.id !== s.id; });
            state.confirmSub = null;
            render();
          }));
          box.appendChild(button("нет", "mini-btn", function () {
            state.confirmSub = null;
            render();
          }));
          line.appendChild(box);
        } else {
          line.appendChild(button("убрать", "mini-btn", function () {
            state.confirmSub = key;
            render();
          }));
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

    var slotSel = el("div", "chips");
    var used = types().map(function (t) { return t.slot; });
    var chosen = { slot: 0 };
    for (var i = 1; i <= 8; i++) {
      if (used.indexOf(i) !== -1) continue;
      if (!chosen.slot) chosen.slot = i;
      (function (slot) {
        var b = el("button", "chip color-chip");
        b.type = "button";
        b.setAttribute("aria-pressed", chosen.slot === slot ? "true" : "false");
        b.appendChild(dot(slot));
        b.addEventListener("click", function () {
          chosen.slot = slot;
          Array.prototype.forEach.call(slotSel.children, function (c, idx) {
            c.setAttribute("aria-pressed", c === b ? "true" : "false");
          });
        });
        slotSel.appendChild(b);
      })(i);
    }
    row.appendChild(button("добавить", "ghost-btn", function () {
      var name = String(nameIn.value).trim();
      if (!name || !chosen.slot) return;
      var draft = editTypes();
      draft.push({
        id: uniqueId(translit(name), draft.map(function (t) { return t.id; })),
        name: name,
        slot: chosen.slot,
        subs: []
      });
      render();
    }));
    card2.appendChild(row);
    if (slotSel.children.length) {
      card2.appendChild(field("Цвет", slotSel));
    } else {
      card2.appendChild(el("div", "summary", "Все восемь цветов заняты."));
    }
    host.appendChild(card2);

    var save = el("div", "card savecard");
    save.appendChild(el("div", "savecard-main"));
    var b = button(state.busy ? "…" : "Сохранить темы", "primary-btn", saveTypes);
    b.disabled = state.busy || !typesDirty();
    save.appendChild(b);
    host.appendChild(save);
  }

  // ── вид: доступ ─────────────────────────────────────────

  function viewAccess(host) {
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
      check();
    }));
    row.appendChild(button("Проверить доступ", "ghost-btn", check));
    row.appendChild(button("Удалить", "ghost-btn", function () {
      TOKEN = null;
      lsDel(LS_TOKEN);
      state.note = "Токен удалён";
      state.noteKind = "";
      render();
    }));
    card.appendChild(row);
    host.appendChild(card);
  }

  function check() {
    if (!TOKEN) {
      state.note = "Токен не задан";
      state.noteKind = "bad";
      return render();
    }
    state.note = "";
    state.noteKind = "";
    render();
    api("").then(function (j) {
      var can = j.permissions && j.permissions.push;
      state.note = can ? "Доступ есть" : "Запись не разрешена";
      state.noteKind = can ? "good" : "bad";
      render();
    }).catch(function (e) {
      state.note = "Не вышло: " + e.message;
      state.noteKind = "bad";
      render();
    });
  }

  // ── каркас ──────────────────────────────────────────────

  var lastScene = null;
  var enterTimer = null;

  function render() {
    var main = document.getElementById("main");
    clear(main);

    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
      t.setAttribute("aria-selected", t.dataset.view === state.view ? "true" : "false");
    });

    /* Анимируется только смена вкладки. Выбор серии её не трогает: список дней
       остаётся на месте, оживает лишь то, что под ним. */
    var scene = state.view;
    if (scene !== lastScene) {
      lastScene = scene;
      main.classList.add("view-enter");
      clearTimeout(enterTimer);
      enterTimer = setTimeout(function () { main.classList.remove("view-enter"); }, 450);
    }

    if (state.note) {
      var banner = el("div", "banner " + (state.noteKind || ""));
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
    else if (state.view === "graves") viewGraves(main);
    else if (state.view === "themes") viewThemes(main);
    else if (state.view === "access") viewAccess(main);
  }

  function setupChrome() {
    var r = repo();
    document.getElementById("brand-sub").textContent =
      (r.owner || "?") + "/" + (r.name || "?");

    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
      t.addEventListener("click", function () {
        state.view = t.dataset.view;
        state.note = "";
        state.noteKind = "";
        state.confirmSub = null;
        state.pickTheme = null;
        render();
      });
    });

    window.addEventListener("beforeunload", function (e) {
      if (state.busy || state.dirty || typesDirty() || gravesDirty()) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  // ── загрузка ────────────────────────────────────────────

  function loadFromFiles() {
    function get(path) {
      return fetch("data/" + path + "?t=" + Date.now(), { cache: "no-store" })
        .then(function (r) {
          if (!r.ok) throw new Error(path + ": " + r.status);
          return r.json();
        });
    }
    // гробария может ещё не быть в репозитории — заводим пустой
    var soft = get("graves.json").catch(function () {
      return { problems: [], solved: {} };
    });
    return Promise.all([
      get("config.json"), get("types.json"), get("students.json"),
      get("series/manifest.json"), soft
    ]).then(function (res) {
      return Promise.all(res[3].series.map(function (f) { return get("series/" + f); }))
        .then(function (series) {
          series.sort(function (a, b) { return a.n - b.n; });
          return {
            config: res[0], types: res[1], students: res[2],
            series: series,
            graves: {
              problems: res[4].problems || [],
              solved: res[4].solved || {}
            }
          };
        });
    });
  }

  function reload() {
    return loadFromFiles().then(function (d) {
      DATA = d;
      pruneSent();
      if (state.typesEdit && !typesDirty()) state.typesEdit = null;
      if (state.graves && !gravesDirty()) state.graves = null;
      render();
    }).catch(function () { render(); });
  }

  document.addEventListener("DOMContentLoaded", function () {
    TOKEN = lsGet(LS_TOKEN, null);
    loadSent();
    loadFromFiles().then(function (d) {
      // страница могла прийти из кэша Pages — тогда уходим на свежую
      var meta = document.querySelector('meta[name="build"]');
      var fresh = d.config.build;
      if (meta && fresh && meta.content !== fresh &&
          new URLSearchParams(location.search).get("b") !== fresh) {
        location.replace(location.pathname + "?b=" + fresh);
        return;
      }
      DATA = d;
      pruneSent();
      setupChrome();
      render();
    }).catch(function (err) {
      var main = document.getElementById("main");
      var box = el("div", "card");
      box.appendChild(el("div", "section-title", "Не удалось загрузить данные"));
      box.appendChild(el("div", "summary", String(err.message || err)));
      main.appendChild(box);
    });
  });
})();
