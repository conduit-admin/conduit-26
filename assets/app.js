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
  var FULL = null;    // рейтинг по всему сразу — им определяется лидер смены

  var state = {
    view: "rating",
    leaves: new Set(),
    series: new Set(),
    kinds: new Set(["problem", "exercise", "grave"]),
    openSeries: 1,
    openStudent: null
  };

  var GRAVES = "graves";   // такой же «день» в списке кондуитов, только без даты

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

  /* Средний балл — сколько очков в среднем приносит один плюс: видно, берёт
     человек дорогие задачи или много дешёвых. */
  function avgScore(score, pluses) {
    return pluses ? (score / pluses).toFixed(3) : "—";
  }

  function isAdmin(id) { return DATA.config.admin && id === DATA.config.admin; }

  function nameCell(tag, cls, student) {
    return el(tag, cls +
      (isAdmin(student.id) ? " admin" : "") +
      (isLeader(student.id) ? " leader" : ""), student.name);
  }

  // ── подготовка данных ───────────────────────────────────

  function leafKey(catId, subId) { return catId + "/" + (subId || ""); }

  /* Гробарий — задачи вне серий: они не привязаны ко дню и потому не попадают
     под отбор по сериям, зато включаются и выключаются отдельным признаком. */
  function graves() { return (DATA.graves && DATA.graves.problems) || []; }

  function graveSolved(id) {
    return (DATA.graves && DATA.graves.solved && DATA.graves.solved[id]) || [];
  }

  function buildIndex() {
    CAT = {};
    DATA.types.forEach(function (t) { CAT[t.id] = t; });

    // какие пары раздел+подраздел реально встречаются в данных
    var seen = {};
    DATA.series.forEach(function (s) {
      s.problems.forEach(function (p) { seen[leafKey(p.type, p.sub)] = true; });
    });
    graves().forEach(function (p) { seen[leafKey(p.type, p.sub)] = true; });

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
          kind: p.exercise ? "exercise" : "problem",
          solvers: solvers,
          solverSet: new Set(solvers),
          weight: DATA.config.students_total - solvers.length
        });
      });
    });

    graves().forEach(function (p) {
      var solvers = [];
      DATA.students.forEach(function (st) {
        if (graveSolved(st.id).indexOf(p.id) !== -1) solvers.push(st.id);
      });
      UNITS.push({
        sn: null,
        id: p.id,
        leafKey: leafKey(p.type, p.sub),
        catId: p.type,
        kind: "grave",
        solvers: solvers,
        solverSet: new Set(solvers),
        weight: DATA.config.students_total - solvers.length
      });
    });

    state.leaves = new Set(LEAVES.map(function (l) { return l.key; }));
    state.series = new Set(DATA.series.map(function (s) { return s.n; }));
    state.openSeries = DATA.series.length
      ? DATA.series[DATA.series.length - 1].n
      : GRAVES;

    /* Лидер смены считается по всему сразу и не зависит от фильтров: он помечен
       одинаково на любой вкладке и при любом отборе. */
    FULL = computeRating(state.series, state.leaves, ALL_KINDS);
  }

  function isLeader(id) {
    return !!FULL && FULL.place[id] === 1 && FULL.rows[0].score > 0;
  }

  var KINDS = [["problem", "Задачи"], ["exercise", "Упражнения"], ["grave", "Гробы"]];
  var ALL_KINDS = new Set(KINDS.map(function (p) { return p[0]; }));

  function allLeaves() {
    return new Set(LEAVES.map(function (l) { return l.key; }));
  }

  function catLeaves(catId) {
    return LEAVES.filter(function (l) { return l.catId === catId; });
  }

  function computeRating(seriesSet, leafSet, kindSet) {
    kindSet = kindSet || state.kinds;
    var rows = DATA.students.map(function (s) {
      return { id: s.id, name: s.name, score: 0, pluses: 0 };
    });
    var byId = {};
    rows.forEach(function (r) { byId[r.id] = r; });

    var available = 0, ceiling = 0;
    UNITS.forEach(function (u) {
      if (u.sn !== null && !seriesSet.has(u.sn)) return;
      if (!leafSet.has(u.leafKey) || !kindSet.has(u.kind)) return;
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

  function filtered() { return computeRating(state.series, state.leaves, state.kinds); }

  // ── общие детали ────────────────────────────────────────

  /* Заливка задаётся обычным цветом. Приём с картинкой-градиентом вместо цвета
     здесь вреден: в Samsung Internet затемняются как раз градиенты, а плоский
     цвет остаётся как задан. Проверено на самом кондуите — полоска темы там
     единственная осталась на чистом цвете и единственная рисовалась верно. */
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
    b.addEventListener("click", onClick);
    return b;
  }

  /* До первой серии считать нечего — показываем состав отряда, чтобы страница
     не выглядела сломанной. */
  function viewEmpty(host) {
    var card = el("div", "card");
    card.appendChild(el("div", "section-title", "Серий пока нет"));
    host.appendChild(card);

    var sh = el("div", "section-head");
    sh.appendChild(el("span", "section-title", "Отряд"));
    host.appendChild(sh);

    var wrap = el("div", "table-wrap");
    var table = el("table", "data");
    var tbody = el("tbody");
    DATA.students.slice().sort(function (a, b) {
      return a.name.localeCompare(b.name, "ru");
    }).forEach(function (s, i) {
      var tr = el("tr");
      tr.appendChild(el("td", "rank", i + 1));
      tr.appendChild(nameCell("td", "left name", s));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    host.appendChild(wrap);
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

    // вид задания — признак, с темой не связанный
    var r3 = el("div", "filter-row");
    var h3 = el("div", "filter-head");
    h3.appendChild(el("span", "filter-title", "Что считаем"));
    r3.appendChild(h3);

    var c3 = el("div", "chips");
    KINDS.forEach(function (pair) {
      var on = state.kinds.has(pair[0]);
      var b = el("button", "chip", pair[1]);
      b.type = "button";
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.addEventListener("click", function () {
        if (on) state.kinds.delete(pair[0]); else state.kinds.add(pair[0]);
        render();
      });
      c3.appendChild(b);
    });
    r3.appendChild(c3);
    card.appendChild(r3);

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

    host.appendChild(card);
    return filtered();
  }

  // ── вид: рейтинг ────────────────────────────────────────

  function viewRating(host) {
    if (!DATA.series.length) return viewEmpty(host);

    var f = renderFilters(host);

    var wrap = el("div", "table-wrap");
    var table = el("table", "data");
    var thead = el("thead");
    var hr = el("tr");
    hr.appendChild(th("№", "rank"));
    hr.appendChild(th("Ученик", "left"));
    hr.appendChild(th("Очки"));
    hr.appendChild(th("Задачи"));
    hr.appendChild(th("Ср. балл"));
    hr.appendChild(th("%", "left"));
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
      tr.appendChild(nameCell("td", "left name", r));
      tr.appendChild(el("td", "score", num(r.score)));
      tr.appendChild(el("td", "muted", r.pluses));
      tr.appendChild(el("td", "muted", avgScore(r.score, r.pluses)));

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

    // строка «Всего» — сколько очков даёт всё учтённое, если решить целиком
    var tfoot = el("tfoot");
    var fr = el("tr", "total-row");
    fr.appendChild(el("td", "rank"));
    fr.appendChild(el("td", "left name", "Всего"));
    fr.appendChild(el("td", "score", num(f.ceiling)));
    fr.appendChild(el("td", "muted", f.available));
    fr.appendChild(el("td", "muted", avgScore(f.ceiling, f.available)));
    fr.appendChild(el("td", "left muted", "100%"));
    tfoot.appendChild(fr);
    table.appendChild(tfoot);

    wrap.appendChild(table);
    host.appendChild(wrap);
  }

  /* Кондуит собран из двух таблиц: слева фамилии, справа прокручиваемые клетки.
     Раньше столбец фамилий залипал внутри одной таблицы, и на телефоне клетки
     при прокрутке налезали на имена — залипание конфликтует со слоями, которые
     браузер заводит под анимации. Две таблицы такого конфликта не создают.
     Высоты строк заданы жёстко, поэтому половинки идут вровень. */
  function conduitTables(problems, rows, cellFor, footFor) {
    var split = el("div", "conduit-split");

    var names = el("table", "conduit names");
    var nHead = el("thead");
    var nhr = el("tr");
    nhr.appendChild(el("th", "pname", "Ученик"));
    nHead.appendChild(nhr);
    names.appendChild(nHead);

    var nBody = el("tbody");
    rows.forEach(function (r) {
      var tr = el("tr", "crow");
      tr.appendChild(nameCell("td", "pname", r));
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
    var cells = el("table", "conduit cells");

    var thead = el("thead");
    var hr = el("tr");
    problems.forEach(function (p) {
      var leaf = LEAF[leafKey(p.type, p.sub)];
      var slot = leaf ? leaf.slot : (CAT[p.type] ? CAT[p.type].slot : 1);
      var cell = el("th");
      var box = el("div", "phead");
      box.appendChild(el("div", "phead-id", p.id));
      var rule = el("div", "phead-rule");
      rule.style.background = "var(--s" + slot + ")";
      box.appendChild(rule);
      cell.appendChild(box);
      hr.appendChild(cell);
    });
    thead.appendChild(hr);
    cells.appendChild(thead);

    var tbody = el("tbody");
    rows.forEach(function (r) {
      var tr = el("tr", "crow");
      problems.forEach(function (p) {
        var td = el("td", "cell");
        td.appendChild(cellFor(p, r));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    cells.appendChild(tbody);

    var tfoot = el("tfoot");
    var f1 = el("tr");
    var f2 = el("tr", "weights");
    problems.forEach(function (p) {
      var pair = footFor(p);
      f1.appendChild(el("td", null, pair[0]));
      f2.appendChild(el("td", null, pair[1]));
    });
    tfoot.appendChild(f1);
    tfoot.appendChild(f2);
    cells.appendChild(tfoot);

    scroll.appendChild(cells);
    split.appendChild(scroll);
    return split;
  }

  // ── вид: кондуиты ───────────────────────────────────────

  function viewSeries(host) {
    if (!DATA.series.length && !graves().length) {
      var none = el("div", "card");
      none.appendChild(el("div", "section-title", "Кондуитов пока нет"));
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

    // гробарий стоит в том же ряду, что и дни: это такой же кондуит, только без даты
    var gb = el("button", "chip day pick");
    gb.type = "button";
    gb.setAttribute("aria-pressed", state.openSeries === GRAVES ? "true" : "false");
    gb.appendChild(el("b", null, "Г"));
    gb.appendChild(el("small", null, "гробы"));
    gb.addEventListener("click", function () {
      state.openSeries = GRAVES;
      render();
    });
    chips.appendChild(gb);

    picker.appendChild(chips);
    host.appendChild(picker);

    if (state.openSeries === GRAVES) return viewGraveConduit(host);

    var s = DATA.series.filter(function (x) { return x.n === state.openSeries; })[0];
    if (!s) return;

    var units = UNITS.filter(function (u) { return u.sn === s.n; });
    var byId = {};
    units.forEach(function (u) { byId[u.id] = u; });

    var sh = el("div", "section-head");
    sh.appendChild(el("span", "section-title", "Серия " + s.n));
    sh.appendChild(el("span", "section-note", prettyDate(s.date)));
    host.appendChild(sh);

    // строки — в порядке результата этой серии
    var order = computeRating(new Set([s.n]), allLeaves(), ALL_KINDS).rows;

    host.appendChild(conduitTables(s.problems, order, function (p, r) {
      return byId[p.id].solverSet.has(r.id) ? el("div", "mark on", "+") : el("div", "mark");
    }, function (p) {
      return [byId[p.id].solvers.length, byId[p.id].weight];
    }));

    host.appendChild(legend(s.problems));
  }

  /* Гробарий в том же виде, что и день: сетка «ученики × задачи», внизу сколько
     человек взяло гроб и сколько он стоит. Порядок строк — по гробам, а не по
     общему рейтингу: иначе таблица не про них. */
  function viewGraveConduit(host) {
    var list = graves();
    if (!list.length) {
      var none = el("div", "card");
      none.appendChild(el("div", "section-title", "Гробов пока нет"));
      host.appendChild(none);
      return;
    }

    var byId = {};
    UNITS.forEach(function (u) { if (u.kind === "grave") byId[u.id] = u; });

    var sh = el("div", "section-head");
    sh.appendChild(el("span", "section-title", "Гробарий"));
    host.appendChild(sh);

    var order = computeRating(new Set(), allLeaves(), new Set(["grave"])).rows;

    host.appendChild(conduitTables(list, order, function (p, r) {
      return byId[p.id].solverSet.has(r.id) ? el("div", "mark on", "+") : el("div", "mark");
    }, function (p) {
      return [byId[p.id].solvers.length, byId[p.id].weight];
    }));

    host.appendChild(legend(list));
  }

  // легенда — только темы, встретившиеся в этом кондуите
  function legend(problems) {
    var used = {};
    problems.forEach(function (p) { used[leafKey(p.type, p.sub)] = true; });

    var box = el("div", "legend");
    DATA.types.forEach(function (t) {
      var mine = catLeaves(t.id).filter(function (l) { return used[l.key]; });
      if (!mine.length) return;
      var item = el("span", "legend-item");
      item.appendChild(dot(t.slot));
      var names = mine.map(function (l) { return l.subName; }).filter(Boolean);
      item.appendChild(document.createTextNode(
        t.name + (names.length ? " · " + names.join(", ") : "")));
      box.appendChild(item);
    });
    return box;
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
    sh.appendChild(nameCell("span", "section-title", student));
    host.appendChild(sh);

    var tiles = el("div", "tiles");
    tiles.appendChild(tile("Место", row.rank + " / " + DATA.students.length, null));
    tiles.appendChild(tile("Очки", num(row.score), "из " + num(f.ceiling)));
    tiles.appendChild(tile("Задачи", row.pluses + " / " + f.available, null));
    var best = bestProblem(id);
    tiles.appendChild(tile("Самый ценный плюс", best ? "+" + best.weight : "—",
      best ? (best.sn === null ? "гроб " + best.id
        : "серия " + best.sn + ", задача " + best.id) : null));
    host.appendChild(tiles);

    var sh2 = el("div", "section-head");
    sh2.appendChild(el("span", "section-title", "По темам"));
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
        catStat.got + " / " + catStat.total + " · " + num(catStat.score)));
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
      mini2.appendChild(b);
    });
    host.appendChild(mini2);
  }

  function statFor(keys, studentId) {
    var set = new Set(keys);
    var total = 0, got = 0, score = 0, solvers = 0, weight = 0;
    UNITS.forEach(function (u) {
      if (u.sn !== null && !state.series.has(u.sn)) return;
      if (!set.has(u.leafKey) || !state.kinds.has(u.kind)) return;
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
      host.appendChild(none);
      return;
    }

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
      var top = computeRating(state.series,
        new Set(leaves.map(function (l) { return l.key; })), state.kinds).rows[0];
      var best = el("div", "tfact");
      best.appendChild(el("span", "tfact-label", "лучший"));
      best.appendChild(top
        ? nameCell("span", "tfact-value", top)
        : el("span", "tfact-value", "—"));
      facts.appendChild(best);
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
  }

  /* Если страница пришла из кэша, а данные уже новее — перезагружаемся по
     адресу с новой меткой: тот же кэш по нему промахнётся и отдаст свежий HTML.
     Метка в адресе заодно защищает от петли: второй раз условие не сработает. */
  function checkStale(config) {
    var meta = document.querySelector('meta[name="build"]');
    var page = meta ? meta.content : null;
    var fresh = config.build;
    if (!page || !fresh || page === fresh) return false;
    if (new URLSearchParams(location.search).get("b") === fresh) return false;
    location.replace(location.pathname + "?b=" + fresh);
    return true;
  }

  function boot(data) {
    if (checkStale(data.config)) return;
    DATA = data;
    DATA.graves = DATA.graves || { problems: [], solved: {} };
    DATA.graves.problems = DATA.graves.problems || [];
    DATA.graves.solved = DATA.graves.solved || {};
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
    // гробария может не быть — это не повод не открыть сайт
    var soft = get("graves.json").catch(function () {
      return { problems: [], solved: {} };
    });
    return Promise.all([
      get("config.json"), get("types.json"), get("students.json"),
      get("series/manifest.json"), soft
    ]).then(function (res) {
      return Promise.all(res[3].series.map(function (f) { return get("series/" + f); }))
        .then(function (series) {
          return {
            config: res[0], types: res[1], students: res[2],
            series: series, graves: res[4]
          };
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
      main.appendChild(box);
    });
  });
})();
