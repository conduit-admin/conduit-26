/* Кондуит — весь подсчёт идёт в браузере читателя.
   Данные приходят одним из двух способов:
     1) window.__CONDUIT__ — офлайн-сборка, всё зашито в один файл;
     2) fetch из папки data/ — обычный режим на сайте.

   Темы двухуровневые: раздел (Алгебра, Геометрия, Комбинаторика, Теория чисел)
   и необязательный подраздел. Единица фильтрации — «лист»: раздел без
   подразбиения или пара раздел+подраздел. Задача без указанного подраздела
   попадает в лист «без уточнения» своего раздела — так новые подразделы можно
   добавлять по ходу смены, ничего не ломая. */

(function () {
  "use strict";

  var DATA = null;    // {config, types, students, series}
  var UNITS = [];     // плоский список единиц зачёта: решившие, вес, лист темы
  var CAT = {};       // id раздела -> раздел
  var LEAVES = [];    // [{key, catId, catName, subId, subName, slot, label}]
  var LEAF = {};      // key -> лист
  var FULL = null;    // рейтинг без фильтров — для сравнения мест

  var state = {
    view: "rating",
    leaves: new Set(),
    series: new Set(),
    openSeries: 1,
    openStudent: null
  };

  var MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  var MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн",
    "июл", "авг", "сен", "окт", "ноя", "дек"];

  // ── мелкие помощники ────────────────────────────────────

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function num(n) { return Number(n).toLocaleString("ru-RU"); }

  function plural(n, one, few, many) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  function withNum(n, one, few, many) {
    return num(n) + " " + plural(n, one, few, many);
  }

  function prettyDate(iso, short) {
    var p = String(iso).split("-");
    if (p.length !== 3) return iso;
    var m = (short ? MONTHS_SHORT : MONTHS)[Number(p[1]) - 1];
    return Number(p[2]) + " " + m;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function pct(x) { return Math.round(x * 100) + "%"; }

  // ── подготовка данных ───────────────────────────────────

  function leafKey(catId, subId) { return catId + "/" + (subId || ""); }

  function buildIndex() {
    CAT = {};
    DATA.types.forEach(function (t) { CAT[t.id] = t; });

    // какие пары раздел+подраздел реально встречаются в данных
    var seen = {};
    DATA.series.forEach(function (s) {
      s.problems.forEach(function (p) { seen[leafKey(p.type, p.sub)] = true; });
    });

    LEAVES = [];
    LEAF = {};
    DATA.types.forEach(function (t) {
      var subs = t.subs || [];
      subs.forEach(function (sub) {
        add(t, sub.id, sub.name, t.name + " · " + sub.name);
      });
      // раздел без подразбиения — либо задачи, которым подраздел не проставили
      if (!subs.length || seen[leafKey(t.id, null)]) {
        add(t, null, subs.length ? "без уточнения" : null,
          subs.length ? t.name + " · без уточнения" : t.name);
      }
    });

    /* Подраздел мог появиться в данных раньше, чем в types.json (например,
       файл серии уехал, а список тем — ещё нет). Заводим лист по факту данных,
       иначе такие задачи молча выпали бы из рейтинга. */
    Object.keys(seen).forEach(function (key) {
      if (LEAF[key]) return;
      var parts = key.split("/");
      var cat = CAT[parts[0]] || { id: parts[0], name: parts[0], slot: 8 };
      var subId = parts[1] || null;
      add(cat, subId, subId, cat.name + (subId ? " · " + subId : ""));
    });

    function add(t, subId, subName, label) {
      var leaf = {
        key: leafKey(t.id, subId),
        catId: t.id,
        catName: t.name,
        subId: subId,
        subName: subName,
        slot: t.slot,
        label: label
      };
      LEAVES.push(leaf);
      LEAF[leaf.key] = leaf;
    }

    UNITS = [];
    DATA.series.forEach(function (s) {
      s.problems.forEach(function (p) {
        var solvers = [];
        DATA.students.forEach(function (st) {
          var list = s.solved[st.id];
          if (list && list.indexOf(p.id) !== -1) solvers.push(st.id);
        });
        UNITS.push({
          sn: s.n,
          id: p.id,
          leafKey: leafKey(p.type, p.sub),
          catId: p.type,
          solvers: solvers,
          solverSet: new Set(solvers),
          weight: DATA.config.students_total - solvers.length
        });
      });
    });

    state.leaves = new Set(LEAVES.map(function (l) { return l.key; }));
    state.series = new Set(DATA.series.map(function (s) { return s.n; }));
    state.openSeries = DATA.series.length ? DATA.series[DATA.series.length - 1].n : 1;
    FULL = computeRating(state.series, state.leaves);
  }

  function catLeaves(catId) {
    return LEAVES.filter(function (l) { return l.catId === catId; });
  }

  function computeRating(seriesSet, leafSet) {
    var rows = DATA.students.map(function (s) {
      return { id: s.id, name: s.name, score: 0, pluses: 0 };
    });
    var byId = {};
    rows.forEach(function (r) { byId[r.id] = r; });

    var available = 0, ceiling = 0;
    UNITS.forEach(function (u) {
      if (!seriesSet.has(u.sn) || !leafSet.has(u.leafKey)) return;
      available += 1;
      ceiling += u.weight;
      u.solvers.forEach(function (id) {
        var r = byId[id];
        if (!r) return;
        r.score += u.weight;
        r.pluses += 1;
      });
    });

    rows.sort(function (a, b) {
      return b.score - a.score || b.pluses - a.pluses || a.name.localeCompare(b.name, "ru");
    });

    var rank = 0, prev = null;
    rows.forEach(function (r, i) {
      var key = r.score + "/" + r.pluses;
      if (key !== prev) { rank = i + 1; prev = key; }
      r.rank = rank;
    });

    var place = {};
    rows.forEach(function (r) { place[r.id] = r.rank; });

    return { rows: rows, available: available, ceiling: ceiling, place: place };
  }

  function filtered() { return computeRating(state.series, state.leaves); }

  function filterActive() {
    return state.leaves.size !== LEAVES.length || state.series.size !== DATA.series.length;
  }

  // ── подсказки ───────────────────────────────────────────

  var tip = null;

  function showTip(target, html) {
    if (!tip) {
      tip = el("div", "tip");
      document.body.appendChild(tip);
    }
    tip.innerHTML = html;
    tip.classList.add("show");
    var r = target.getBoundingClientRect();
    var t = tip.getBoundingClientRect();
    var left = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 8);
    var top = r.top - t.height - 8;
    if (top < 8) top = r.bottom + 8;
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  function hideTip() { if (tip) tip.classList.remove("show"); }

  function tipify(node, html) {
    node.addEventListener("mouseenter", function () { showTip(node, html); });
    node.addEventListener("mouseleave", hideTip);
  }

  // ── общие детали ────────────────────────────────────────

  function dot(slot) {
    var d = el("span", "dot");
    d.style.background = "var(--s" + slot + ")";
    return d;
  }

  function mini(text, fn) {
    var b = el("button", "mini-btn", text);
    b.type = "button";
    b.addEventListener("click", fn);
    return b;
  }

  function dayChip(s, pressed, extraClass, onClick) {
    var b = el("button", "chip day" + (extraClass ? " " + extraClass : ""));
    b.type = "button";
    b.setAttribute("aria-pressed", pressed ? "true" : "false");
    b.appendChild(el("b", null, s.n));
    b.appendChild(el("small", null, prettyDate(s.date, true)));
    tipify(b, "Серия " + s.n + " · " + prettyDate(s.date) + "<br>" +
      withNum(s.problems.length, "задача", "задачи", "задач"));
    b.addEventListener("click", onClick);
    return b;
  }

  /* До первой серии считать нечего — показываем состав отряда, чтобы страница
     не выглядела сломанной. */
  function viewEmpty(host) {
    var card = el("div", "card");
    card.appendChild(el("div", "section-title", "Серий пока нет"));
    card.appendChild(el("div", "summary",
      "Как только первый кондуит попадёт в систему, здесь появится рейтинг: " +
      "баллы, плюсы и пересчёт по любым темам и дням."));
    host.appendChild(card);

    var sh = el("div", "section-head");
    sh.appendChild(el("span", "section-title", "Отряд"));
    sh.appendChild(el("span", "section-note",
      withNum(DATA.students.length, "человек", "человека", "человек")));
    host.appendChild(sh);

    var wrap = el("div", "table-wrap");
    var table = el("table", "data");
    var tbody = el("tbody");
    DATA.students.slice().sort(function (a, b) {
      return a.name.localeCompare(b.name, "ru");
    }).forEach(function (s, i) {
      var tr = el("tr");
      tr.appendChild(el("td", "rank", i + 1));
      tr.appendChild(el("td", "left name", s.name));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    host.appendChild(wrap);

    host.appendChild(el("div", "foot",
      "Вес задачи считается от " + DATA.config.students_total +
      " учеников — это число зафиксировано на смену."));
  }

  function tile(label, value, note) {
    var t = el("div", "tile");
    t.appendChild(el("div", "tile-label", label));
    t.appendChild(el("div", "tile-value", value));
    if (note) t.appendChild(el("div", "tile-note", note));
    return t;
  }

  function th(text, cls) { return el("th", cls, text); }

  // ── фильтры ─────────────────────────────────────────────

  function renderFilters(host) {
    var card = el("div", "card filters");

    // темы
    var r1 = el("div", "filter-row");
    var h1 = el("div", "filter-head");
    h1.appendChild(el("span", "filter-title", "Темы"));
    h1.appendChild(mini("все", function () {
      state.leaves = new Set(LEAVES.map(function (l) { return l.key; }));
      render();
    }));
    h1.appendChild(mini("ни одной", function () {
      state.leaves = new Set();
      render();
    }));
    r1.appendChild(h1);

    DATA.types.forEach(function (t) {
      var leaves = catLeaves(t.id);
      if (!leaves.length) return;
      var on = leaves.filter(function (l) { return state.leaves.has(l.key); }).length;

      var group = el("div", "tgroup");

      var cat = el("button", "chip cat" + (on && on < leaves.length ? " partial" : ""));
      cat.type = "button";
      cat.setAttribute("aria-pressed", on ? "true" : "false");
      cat.appendChild(dot(t.slot));
      cat.appendChild(document.createTextNode(t.name));
      if (leaves.length > 1) {
        cat.appendChild(el("span", "chip-count", on + "/" + leaves.length));
      }
      cat.addEventListener("click", function () {
        var all = on === leaves.length;
        leaves.forEach(function (l) {
          if (all) state.leaves.delete(l.key); else state.leaves.add(l.key);
        });
        render();
      });
      group.appendChild(cat);

      if (leaves.length > 1 || leaves[0].subName) {
        var subs = el("div", "subs");
        leaves.forEach(function (l) {
          var b = el("button", "chip sub", l.subName || t.name);
          b.type = "button";
          b.setAttribute("aria-pressed", state.leaves.has(l.key) ? "true" : "false");
          b.style.setProperty("--accent", "var(--s" + t.slot + ")");
          b.addEventListener("click", function () {
            if (state.leaves.has(l.key)) state.leaves.delete(l.key);
            else state.leaves.add(l.key);
            render();
          });
          subs.appendChild(b);
        });
        group.appendChild(subs);
      }

      r1.appendChild(group);
    });
    card.appendChild(r1);

    // серии
    var r2 = el("div", "filter-row");
    var h2 = el("div", "filter-head");
    h2.appendChild(el("span", "filter-title", "Серии"));
    h2.appendChild(mini("все", function () {
      state.series = new Set(DATA.series.map(function (s) { return s.n; }));
      render();
    }));
    h2.appendChild(mini("последние 5", function () {
      state.series = new Set(DATA.series.slice(-5).map(function (s) { return s.n; }));
      render();
    }));
    h2.appendChild(mini("ни одной", function () {
      state.series = new Set();
      render();
    }));
    r2.appendChild(h2);

    var c2 = el("div", "chips");
    DATA.series.forEach(function (s) {
      c2.appendChild(dayChip(s, state.series.has(s.n), null, function () {
        if (state.series.has(s.n)) state.series.delete(s.n);
        else state.series.add(s.n);
        render();
      }));
    });
    r2.appendChild(c2);
    card.appendChild(r2);

    var f = filtered();
    var sum = el("div", "summary");
    sum.innerHTML =
      "Учтено <b>" + state.series.size + "</b> из " + DATA.series.length + " " +
      plural(DATA.series.length, "серии", "серий", "серий") +
      " · <b>" + f.available + "</b> из " + UNITS.length + " задач" +
      " · потолок <b>" + num(f.ceiling) + "</b> " + plural(f.ceiling, "балл", "балла", "баллов");
    card.appendChild(sum);

    host.appendChild(card);
    return f;
  }

  // ── вид: рейтинг ────────────────────────────────────────

  function viewRating(host) {
    if (!DATA.series.length) return viewEmpty(host);

    var f = renderFilters(host);
    var active = filterActive();

    var tiles = el("div", "tiles");
    tiles.appendChild(tile("Учеников", num(DATA.config.students_total),
      "число зафиксировано в начале смены"));
    tiles.appendChild(tile("Серий в фильтре", state.series.size + " / " + DATA.series.length, null));
    tiles.appendChild(tile("Задач в фильтре", f.available + " / " + UNITS.length, null));
    tiles.appendChild(tile("Потолок баллов", num(f.ceiling), "если решить всё учтённое"));
    host.appendChild(tiles);

    var wrap = el("div", "table-wrap");
    var table = el("table", "data");
    var thead = el("thead");
    var hr = el("tr");
    hr.appendChild(th("№", "rank"));
    if (active) hr.appendChild(th("сдвиг"));
    hr.appendChild(th("Ученик", "left"));
    hr.appendChild(th("Баллы"));
    hr.appendChild(th("Плюсы"));
    hr.appendChild(th("Доля решённого", "left"));
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el("tbody");
    f.rows.forEach(function (r) {
      var tr = el("tr", "clickable");
      tr.addEventListener("click", function () {
        state.openStudent = r.id;
        render();
        window.scrollTo(0, 0);
      });

      tr.appendChild(el("td", "rank" + (r.rank <= 3 ? " rank-top" : ""), r.rank));

      if (active) {
        var was = FULL.place[r.id];
        var d = was - r.rank;
        var cell = el("td");
        var span = el("span", "delta " + (d > 0 ? "up" : d < 0 ? "down" : "same"));
        span.textContent = d > 0 ? "▲ " + d : d < 0 ? "▼ " + (-d) : "—";
        tipify(span, "Без фильтра — " + was + " место");
        cell.appendChild(span);
        tr.appendChild(cell);
      }

      tr.appendChild(el("td", "left name", r.name));
      tr.appendChild(el("td", "score", num(r.score)));
      tr.appendChild(el("td", "muted", r.pluses));

      var share = f.available ? r.pluses / f.available : 0;
      var td = el("td", "left");
      var track = el("span", "bar-track");
      var bar = el("span", "bar");
      bar.style.width = Math.max(2, Math.round(share * 74)) + "px";
      track.appendChild(bar);
      td.appendChild(track);
      td.appendChild(el("span", "muted", pct(share)));
      tr.appendChild(td);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    host.appendChild(wrap);

    var note = el("div", "foot");
    note.textContent = "Вес задачи = " + DATA.config.students_total +
      " − число решивших. Задача, которую сдали трое, стоит " +
      (DATA.config.students_total - 3) + " баллов; задача, которую сдали все, — 0. " +
      "Вес не зависит от выбранного фильтра, поэтому рейтинги сопоставимы между собой.";
    host.appendChild(note);
  }

  // ── вид: кондуиты ───────────────────────────────────────

  function viewSeries(host) {
    if (!DATA.series.length) {
      var none = el("div", "card");
      none.appendChild(el("div", "section-title", "Кондуитов пока нет"));
      none.appendChild(el("div", "summary",
        "Здесь будет по кондуиту на каждый день: сетка «ученики × задачи», " +
        "сколько человек решило каждую задачу и сколько она стоит."));
      host.appendChild(none);
      return;
    }

    var picker = el("div", "card");
    var head = el("div", "filter-head");
    head.appendChild(el("span", "filter-title", "День"));
    picker.appendChild(head);
    var chips = el("div", "chips");
    DATA.series.forEach(function (s) {
      chips.appendChild(dayChip(s, s.n === state.openSeries, "pick", function () {
        state.openSeries = s.n;
        render();
      }));
    });
    picker.appendChild(chips);
    host.appendChild(picker);

    var s = DATA.series.filter(function (x) { return x.n === state.openSeries; })[0];
    if (!s) return;

    var units = UNITS.filter(function (u) { return u.sn === s.n; });
    var byId = {};
    units.forEach(function (u) { byId[u.id] = u; });

    var sh = el("div", "section-head");
    sh.appendChild(el("span", "section-title", "Серия " + s.n));
    sh.appendChild(el("span", "section-note", prettyDate(s.date) + " · " +
      withNum(s.problems.length, "задача", "задачи", "задач") + " · всего сдано " +
      withNum(units.reduce(function (a, u) { return a + u.solvers.length; }, 0),
        "плюс", "плюса", "плюсов")));
    host.appendChild(sh);

    var scroll = el("div", "conduit-scroll");
    var table = el("table", "conduit");

    var thead = el("thead");
    var hr = el("tr");
    hr.appendChild(el("th", "pname", "Ученик"));
    s.problems.forEach(function (p) {
      var leaf = LEAF[leafKey(p.type, p.sub)];
      var slot = leaf ? leaf.slot : (CAT[p.type] ? CAT[p.type].slot : 1);
      var cell = el("th");
      var box = el("div", "phead");
      box.appendChild(el("div", "phead-id", p.id));
      var rule = el("div", "phead-rule");
      rule.style.background = "var(--s" + slot + ")";
      box.appendChild(rule);
      cell.appendChild(box);
      tipify(cell, "Задача " + p.id + " · " + (leaf ? leaf.label : p.type) +
        "<br>решили " + byId[p.id].solvers.length + " из " + DATA.config.students_total +
        " · вес " + byId[p.id].weight);
      hr.appendChild(cell);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    // строки — в порядке результата этой серии
    var order = computeRating(new Set([s.n]),
      new Set(LEAVES.map(function (l) { return l.key; }))).rows;

    var tbody = el("tbody");
    order.forEach(function (r) {
      var tr = el("tr", "crow");
      tr.appendChild(el("td", "pname", r.name));
      s.problems.forEach(function (p) {
        var u = byId[p.id];
        var on = u.solverSet.has(r.id);
        var td = el("td", "cell");
        td.appendChild(el("div", "mark" + (on ? " on" : "")));
        tipify(td, r.name + "<br>задача " + p.id + " — " + (on ? "плюс, +" + u.weight : "нет"));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    var tfoot = el("tfoot");
    var f1 = el("tr");
    f1.appendChild(el("td", "pname", "решили"));
    s.problems.forEach(function (p) { f1.appendChild(el("td", null, byId[p.id].solvers.length)); });
    tfoot.appendChild(f1);
    var f2 = el("tr", "weights");
    f2.appendChild(el("td", "pname", "вес"));
    s.problems.forEach(function (p) { f2.appendChild(el("td", null, byId[p.id].weight)); });
    tfoot.appendChild(f2);
    table.appendChild(tfoot);

    scroll.appendChild(table);
    host.appendChild(scroll);

    // легенда — только темы, встретившиеся в этой серии
    var used = {};
    s.problems.forEach(function (p) { used[leafKey(p.type, p.sub)] = true; });
    var legend = el("div", "legend");
    DATA.types.forEach(function (t) {
      var mine = catLeaves(t.id).filter(function (l) { return used[l.key]; });
      if (!mine.length) return;
      var item = el("span", "legend-item");
      item.appendChild(dot(t.slot));
      var names = mine.map(function (l) { return l.subName; }).filter(Boolean);
      item.appendChild(document.createTextNode(
        t.name + (names.length ? " · " + names.join(", ") : "")));
      legend.appendChild(item);
    });
    host.appendChild(legend);
  }

  // ── вид: ученики ────────────────────────────────────────

  function viewStudentCard(host, id) {
    var back = el("button", "back-btn", "← к рейтингу");
    back.type = "button";
    back.addEventListener("click", function () { state.openStudent = null; render(); });
    host.appendChild(back);

    var student = DATA.students.filter(function (s) { return s.id === id; })[0];
    var f = filtered();
    var row = f.rows.filter(function (r) { return r.id === id; })[0];

    var sh = el("div", "section-head");
    sh.appendChild(el("span", "section-title", student.name));
    if (filterActive()) {
      sh.appendChild(el("span", "section-note",
        "по текущему фильтру · без фильтра " + FULL.place[id] + " место"));
    }
    host.appendChild(sh);

    var tiles = el("div", "tiles");
    tiles.appendChild(tile("Место", row.rank + " / " + DATA.students.length, null));
    tiles.appendChild(tile("Баллы", num(row.score), "из " + num(f.ceiling) + " возможных"));
    tiles.appendChild(tile("Плюсы", row.pluses + " / " + f.available, null));
    var best = bestProblem(id);
    tiles.appendChild(tile("Самый ценный плюс", best ? "+" + best.weight : "—",
      best ? "серия " + best.sn + ", задача " + best.id : null));
    host.appendChild(tiles);

    var sh2 = el("div", "section-head");
    sh2.appendChild(el("span", "section-title", "По темам"));
    sh2.appendChild(el("span", "section-note", "по выбранным сериям, темы показаны все"));
    host.appendChild(sh2);

    var card = el("div", "card");
    DATA.types.forEach(function (t) {
      var leaves = catLeaves(t.id);
      if (!leaves.length) return;

      var catStat = statFor(leaves.map(function (l) { return l.key; }), id);
      var block = el("div", "tblock");

      var head = el("div", "tblock-head");
      var nameBox = el("span", "type-name");
      nameBox.appendChild(dot(t.slot));
      nameBox.appendChild(el("b", null, t.name));
      head.appendChild(nameBox);
      head.appendChild(el("span", "type-val",
        catStat.got + " / " + catStat.total + " · " + num(catStat.score) + " б."));
      block.appendChild(head);

      block.appendChild(trackBar(catStat.total ? catStat.got / catStat.total : 0, t.slot));

      if (leaves.length > 1 || leaves[0].subName) {
        leaves.forEach(function (l) {
          var st = statFor([l.key], id);
          var line = el("div", "subline");
          line.appendChild(el("span", "subline-name", l.subName || t.name));
          line.appendChild(el("span", "subline-val",
            st.got + " / " + st.total + " · " + num(st.score)));
          block.appendChild(line);
        });
      }

      card.appendChild(block);
    });
    host.appendChild(card);

    var sh3 = el("div", "section-head");
    sh3.appendChild(el("span", "section-title", "По сериям"));
    host.appendChild(sh3);

    var mini2 = el("div", "series-mini");
    DATA.series.forEach(function (s) {
      var got = 0, total = 0, score = 0;
      UNITS.forEach(function (u) {
        if (u.sn !== s.n) return;
        total += 1;
        if (u.solverSet.has(id)) { got += 1; score += u.weight; }
      });
      var b = el("span", "smini");
      b.innerHTML = "С" + s.n + " · <b>" + got + "</b>/" + total + " · " + num(score);
      tipify(b, prettyDate(s.date) + "<br>" + withNum(score, "балл", "балла", "баллов"));
      mini2.appendChild(b);
    });
    host.appendChild(mini2);
  }

  function statFor(keys, studentId) {
    var set = new Set(keys);
    var total = 0, got = 0, score = 0, solvers = 0, weight = 0;
    UNITS.forEach(function (u) {
      if (!set.has(u.leafKey) || !state.series.has(u.sn)) return;
      total += 1;
      solvers += u.solvers.length;
      weight += u.weight;
      if (studentId && u.solverSet.has(studentId)) { got += 1; score += u.weight; }
    });
    return {
      total: total,
      got: got,
      score: score,
      rate: total ? solvers / (total * DATA.config.students_total) : 0,
      avgWeight: total ? weight / total : 0
    };
  }

  function trackBar(share, slot) {
    var track = el("div", "track");
    var fill = el("i");
    fill.style.width = Math.round(share * 100) + "%";
    fill.style.background = "var(--s" + slot + ")";
    track.appendChild(fill);
    return track;
  }

  function bestProblem(id) {
    var best = null;
    UNITS.forEach(function (u) {
      if (!u.solverSet.has(id)) return;
      if (!best || u.weight > best.weight) best = u;
    });
    return best;
  }

  // ── вид: темы ───────────────────────────────────────────

  function viewTypes(host) {
    if (!UNITS.length) {
      var none = el("div", "card");
      none.appendChild(el("div", "section-title", "Задач пока нет"));
      none.appendChild(el("div", "summary",
        "Темы уже заданы: " + DATA.types.map(function (t) { return t.name; }).join(", ") +
        ". Решаемость по ним появится, когда будут размечены первые задачи."));
      host.appendChild(none);
      return;
    }

    var note = el("div", "section-note");
    note.textContent = "По сериям, выбранным в фильтре на вкладке «Рейтинг». " +
      "Решаемость — какая доля учеников в среднем берёт задачу этой темы.";
    host.appendChild(note);

    var grid = el("div", "tcards");

    DATA.types.forEach(function (t) {
      var leaves = catLeaves(t.id);
      if (!leaves.length) return;
      var st = statFor(leaves.map(function (l) { return l.key; }), null);
      if (!st.total) return;

      var card = el("div", "card tcard");

      var head = el("div", "tblock-head");
      var nameBox = el("span", "type-name");
      nameBox.appendChild(dot(t.slot));
      nameBox.appendChild(el("b", null, t.name));
      head.appendChild(nameBox);
      head.appendChild(el("span", "type-val", withNum(st.total, "задача", "задачи", "задач")));
      card.appendChild(head);

      var facts = el("div", "tfacts");
      facts.appendChild(fact("решаемость", pct(st.rate)));
      facts.appendChild(fact("средний вес", st.avgWeight.toFixed(1)));
      var top = computeRating(state.series,
        new Set(leaves.map(function (l) { return l.key; }))).rows[0];
      facts.appendChild(fact("лучший", top ? top.name : "—"));
      card.appendChild(facts);

      if (leaves.length > 1 || leaves[0].subName) {
        var subs = el("div", "tsubs");
        leaves.forEach(function (l) {
          var ls = statFor([l.key], null);
          var line = el("div", "subline");
          line.appendChild(el("span", "subline-name", l.subName || t.name));
          var bar = trackBar(ls.rate, t.slot);
          bar.className = "track thin";
          line.appendChild(bar);
          line.appendChild(el("span", "subline-val",
            ls.total + " " + plural(ls.total, "задача", "задачи", "задач") + " · " + pct(ls.rate)));
          subs.appendChild(line);
        });
        card.appendChild(subs);
      }

      grid.appendChild(card);
    });

    host.appendChild(grid);
  }

  function fact(label, value) {
    var f = el("div", "tfact");
    f.appendChild(el("span", "tfact-label", label));
    f.appendChild(el("span", "tfact-value", value));
    return f;
  }

  // ── каркас ──────────────────────────────────────────────

  var lastScene = null;
  var enterTimer = null;

  function render() {
    hideTip();
    var main = document.getElementById("main");
    clear(main);

    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
      t.setAttribute("aria-selected", t.dataset.view === state.view ? "true" : "false");
    });

    // анимируем только смену раздела или открытие ученика, но не пересчёт фильтра
    var scene = state.view + "/" + (state.openStudent || "");
    if (scene !== lastScene) {
      lastScene = scene;
      main.classList.add("view-enter");
      clearTimeout(enterTimer);
      enterTimer = setTimeout(function () { main.classList.remove("view-enter"); }, 450);
    }

    if (state.view === "rating") {
      if (state.openStudent) viewStudentCard(main, state.openStudent);
      else viewRating(main);
    } else if (state.view === "series") viewSeries(main);
    else if (state.view === "types") viewTypes(main);
  }

  function setupChrome() {
    document.getElementById("brand-title").textContent = DATA.config.title;
    var sub = DATA.config.subtitle || "";
    if (DATA.config.offline_date) {
      var d = String(DATA.config.offline_date).split("-");
      sub += (sub ? " · " : "") + "офлайн-копия от " + d[2] + "." + d[1] + "." + d[0];
    }
    document.getElementById("brand-sub").textContent = sub;
    document.title = DATA.config.title + " — " + (DATA.config.subtitle || "");

    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
      t.addEventListener("click", function () {
        state.view = t.dataset.view;
        state.openStudent = null;
        render();
      });
    });

    window.addEventListener("scroll", hideTip, { passive: true });
  }

  function boot(data) {
    DATA = data;
    DATA.series.sort(function (a, b) { return a.n - b.n; });
    buildIndex();
    setupChrome();
    render();
  }

  function loadFromFiles() {
    var base = "data/";
    function get(path) {
      return fetch(base + path, { cache: "no-store" }).then(function (r) {
        if (!r.ok) throw new Error(path + ": " + r.status);
        return r.json();
      });
    }
    return Promise.all([
      get("config.json"), get("types.json"), get("students.json"), get("series/manifest.json")
    ]).then(function (res) {
      return Promise.all(res[3].series.map(function (f) { return get("series/" + f); }))
        .then(function (series) {
          return { config: res[0], types: res[1], students: res[2], series: series };
        });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (window.__CONDUIT__) { boot(window.__CONDUIT__); return; }
    loadFromFiles().then(boot).catch(function (err) {
      var main = document.getElementById("main");
      clear(main);
      var box = el("div", "card");
      box.appendChild(el("div", "section-title", "Не удалось загрузить данные"));
      box.appendChild(el("div", "tile-note", String(err.message || err)));
      box.appendChild(el("div", "tile-note",
        "Если файл открыт с диска напрямую, браузер не даёт читать соседние файлы — " +
        "для локального просмотра используйте офлайн-сборку."));
      main.appendChild(box);
    });
  });
})();
