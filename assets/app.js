/* Кондуит — весь подсчёт идёт в браузере читателя.
   Данные приходят одним из двух способов:
     1) window.__CONDUIT__ — офлайн-сборка, всё зашито в один файл;
     2) fetch из папки data/ — обычный режим на сайте.

   Темы двухуровневые: раздел (Алгебра, Геометрия, Комбинаторика, Теория чисел)
   и необязательный подраздел. Единица фильтрации — «лист»: раздел без
   подразбиения или пара раздел+подраздел. Задаче разбитого раздела подраздел
   ставят всегда; если он всё же пуст или незнаком, лист заводится по факту
   данных — иначе такая задача молча выпала бы из рейтинга. */

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

  /* День смены бывает трёх видов. Выходной и матбой занимают номер и дату, но
     задач не несут: они нужны, чтобы в ряду дней не было дыр и было видно ритм
     смены. */
  var DAY_NAME = { off: "Выходной", battle: "Математический бой" };
  var DAY_MARK = { off: "В", battle: "М" };

  /* Упражнение — не тема, а вид задания: узнаётся по нулевому номеру (0, 0а).
     То же правило в редакторе — одно на оба места, иначе задача считалась бы
     упражнением на сайте и задачей в редакторе. */
  function numPrefix(id) {
    var m = String(id).match(/^(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  function isExercise(p) { return numPrefix(p.id) === 0; }

  // подпись внизу карточки ученика: и кому, и что — из настроек
  function signature(id) {
    var s = DATA.config.signature;
    return s && s.on && s.student === id && s.text ? s.text : null;
  }

  /* Вес задачи = n − число решивших. По умолчанию n — это число учеников на
     смене, но его можно задать отдельно из редактора: тогда цена задачи
     считается от него, а не от состава отряда. */
  function weightBase() {
    var n = DATA.config.scoring && DATA.config.scoring.n;
    return typeof n === "number" && n > 0 ? n : DATA.config.students_total;
  }

  /* Ниже одного очка вес не опускается. Задача, которую взяли все, всё-таки
     была решена: обнулять её значило бы, что плюс за неё не стоит ничего — а он
     стоит, просто самую малость. Правило то же в редакторе. */
  function weightOf(solvers) { return Math.max(weightBase() - solvers, 1); }

  /* Цену задачи можно задать вручную — тогда формула к ней не применяется.
     Ставится она в редакторе: формула знает только число решивших, а задача
     бывает дорога и не поэтому. */
  function priceOf(p, solvers) {
    var w = p && p.weight;
    return typeof w === "number" && isFinite(w) && w > 0
      ? Math.round(w) : weightOf(solvers);
  }

  function dayKind(s) { return s.kind || "series"; }

  /* Номер есть только у дня с серией, и это номер самой серии. Выходной и матбой
     номеров не занимают — в ленте они помечены буквой. У старых файлов своего
     поля нет: там номер дня и был номером серии. */
  function seriesNo(s) {
    return s.series === undefined || s.series === null ? s.n : s.series;
  }

  function dayMark(s) {
    return dayKind(s) === "series" ? String(seriesNo(s)) : DAY_MARK[dayKind(s)];
  }

  // единицы зачёта помнят слот дня — наружу показывается номер серии
  function seriesNoBySlot(sn) {
    var s = DATA.series.filter(function (x) { return x.n === sn; })[0];
    return s ? seriesNo(s) : sn;
  }

  /* В кондуите ученики стоят по алфавиту, а не по результату дня: кондуит —
     ведомость, в ней ищут человека, а не место. Полное имя сравнивается
     целиком, поэтому однофамильцы идут по именам. */
  function byName(rows) {
    return rows.slice().sort(function (a, b) {
      return a.name.localeCompare(b.name, "ru");
    });
  }

  function hasTasks(s) { return dayKind(s) === "series" && s.problems.length > 0; }

  function realSeries() { return DATA.series.filter(hasTasks); }

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

  /* Имя со значками. Значки — настоящие элементы, а не псевдоэлемент: их может
     быть два сразу, у каждого свой цвет, и порядок важен — сначала редактор,
     потом корона. Имя обрезается, значки — никогда. */
  function nameCell(tag, cls, student) {
    var node = el(tag, cls);
    var box = el("span", "name-box");
    box.appendChild(el("span", "nm", student.name));
    if (isAdmin(student.id)) box.appendChild(el("i", "badge-admin", "◆"));
    if (isLeader(student.id)) box.appendChild(el("i", "badge-leader"));
    node.appendChild(box);
    return node;
  }

  // ── подготовка данных ───────────────────────────────────

  function leafKey(catId, subId) { return catId + "/" + (subId || ""); }

  /* Задача, чей подраздел удалили из списка тем, остаётся без темы: лист под
     неё не заводится, и в рейтинг она не идёт, пока ей не выберут тему заново.
     В кондуите она при этом видна — с серой полоской вместо цветной. */
  function unitLeaf(p) {
    var key = leafKey(p.type, p.sub);
    return LEAF[key] ? key : null;
  }

  /* Гробарий — задачи вне серий: они не привязаны ко дню и потому не попадают
     под отбор по сериям, зато включаются и выключаются отдельным признаком. */
  function graves() { return (DATA.graves && DATA.graves.problems) || []; }

  /* Гроборешение — отдельная запись «кто какой гроб взял». Гробы штучные, и
     сетка «ученики × гробы» под них не годится: она почти пуста, а надбавку за
     конкретное решение в клетке «+» показать нечем.

     У файлов, записанных до разделения, вместо списка решений лежит карта
     solved — читаем и её, иначе на старых данных гробарий оказался бы пуст. */
  function graveSolutions() {
    var g = DATA.graves || {};
    if (Array.isArray(g.solutions)) return g.solutions;
    var out = [];
    Object.keys(g.solved || {}).forEach(function (sid) {
      (g.solved[sid] || []).forEach(function (pid) {
        out.push({ student: sid, problem: pid, bonus: 0 });
      });
    });
    return out;
  }

  /* Надбавка ставится за само решение, а не человеку вообще: она прибавляется
     к цене гроба и вместе с ней достаётся тому, кто его взял. */
  function solutionBonus(s) {
    var v = s && s.bonus;
    return typeof v === "number" && isFinite(v) && v > 0 ? v : 0;
  }

  // сколько принёс этот плюс имеющему его ученику: цена задачи плюс надбавка
  function unitValue(u, id) {
    return u.weight + ((u.bonus && u.bonus[id]) || 0);
  }

  /* Ликбезы — приложенные к смене pdf. Со счётом они никак не связаны: это
     просто файлы, которые надо раздать. Список лежит в data/likbez.json, сами
     файлы — в data/likbez/. */
  function likbez() {
    var items = DATA.likbez && DATA.likbez.items;
    return Array.isArray(items) ? items : [];
  }

  /* Размер словами: килобайты до мегабайта, дальше мегабайты с десятой. Точный
     байт никому не нужен — важно понять, ждать ли загрузку с телефона. */
  function fileSize(n) {
    if (typeof n !== "number" || !isFinite(n) || n <= 0) return "";
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + " КБ";
    return (n / 1024 / 1024).toFixed(1).replace(".", ",") + " МБ";
  }

  function buildIndex() {
    CAT = {};
    DATA.types.forEach(function (t) { CAT[t.id] = t; });

    LEAVES = [];
    LEAF = {};
    DATA.types.forEach(function (t) {
      var subs = t.subs || [];
      subs.forEach(function (sub) {
        add(t, sub.id, sub.name, t.name + " · " + sub.name);
      });
      // раздел без подразбиения — один лист на весь раздел
      if (!subs.length) add(t, null, null, t.name);
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
          leafKey: unitLeaf(p),
          catId: p.type,
          kind: isExercise(p) ? "exercise" : "problem",
          solvers: solvers,
          solverSet: new Set(solvers),
          weight: priceOf(p, solvers.length)
        });
      });
    });

    /* Гроб собирается из своих решений: чужой ученик в счёт не идёт, повтор —
       тоже. И то и другое сдвинуло бы число решивших, а значит и цену гроба. */
    var known = {};
    DATA.students.forEach(function (s) { known[s.id] = true; });
    var solutions = graveSolutions();

    graves().forEach(function (p) {
      var solvers = [];
      var bonus = {};
      solutions.forEach(function (s) {
        if (s.problem !== p.id || !known[s.student]) return;
        if (solvers.indexOf(s.student) !== -1) return;
        solvers.push(s.student);
        bonus[s.student] = solutionBonus(s);
      });
      UNITS.push({
        sn: null,
        id: p.id,
        leafKey: unitLeaf(p),
        catId: p.type,
        kind: "grave",
        solvers: solvers,
        solverSet: new Set(solvers),
        bonus: bonus,
        weight: priceOf(p, solvers.length)
      });
    });

    state.leaves = new Set(LEAVES.map(function (l) { return l.key; }));
    state.series = new Set(realSeries().map(function (s) { return s.n; }));
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
        // надбавка за решение достаётся только тому, кому её поставили
        r.score += unitValue(u, id);
        r.pluses += 1;
      });
    });

    /* Сначала очки, при равенстве — по алфавиту. Место у каждого своё: делить
       одно место на двоих в таблице из двух десятков человек неудобно. */
    rows.sort(function (a, b) {
      return b.score - a.score || a.name.localeCompare(b.name, "ru");
    });
    rows.forEach(function (r, i) { r.rank = i + 1; });

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
    var kind = dayKind(s);
    var b = el("button", "chip day" + (extraClass ? " " + extraClass : "") +
      (kind === "series" ? "" : " " + kind));
    b.type = "button";
    b.setAttribute("aria-pressed", pressed ? "true" : "false");
    // дата стоит всегда, а сверху — номер серии либо буква дня
    b.appendChild(el("b", null, dayMark(s)));
    b.appendChild(el("small", null, prettyDate(s.date, true)));
    b.addEventListener("click", onClick);
    return b;
  }

  /* До первой серии считать нечего — показываем состав отряда, чтобы страница
     не выглядела сломанной. Дни при этом могут уже быть: смена вполне может
     начаться с выходного, и говорить «дней нет» тогда неправда. */
  function viewEmpty(host) {
    var card = el("div", "card");
    card.appendChild(el("div", "section-title",
      DATA.series.length ? "Задач пока нет" : "Дней пока нет"));
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

    // дни; выходные и матбои сюда не попадают — считать в них нечего
    var days = realSeries();
    if (!days.length) {   // отбирать нечего: до первой серии строка пуста
      host.appendChild(card);
      return filtered();
    }

    var r2 = el("div", "filter-row");
    var h2 = el("div", "filter-head");
    h2.appendChild(el("span", "filter-title", "Дни"));
    h2.appendChild(mini("все", function () {
      state.series = new Set(days.map(function (s) { return s.n; }));
      render();
    }));
    h2.appendChild(mini("последние 5", function () {
      state.series = new Set(days.slice(-5).map(function (s) { return s.n; }));
      render();
    }));
    h2.appendChild(mini("ни одной", function () {
      state.series = new Set();
      render();
    }));
    r2.appendChild(h2);

    var c2 = el("div", "chips");
    days.forEach(function (s) {
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
    if (!UNITS.length) return viewEmpty(host);

    var f = renderFilters(host);

    /* Ширины колонок закреплены: при автоматической раскладке они зависят от
       самого длинного числа в столбце, и таблица переезжала при каждом
       переключении фильтра. */
    var wrap = el("div", "table-wrap");
    var table = el("table", "data fixed");
    var thead = el("thead");
    var hr = el("tr");
    hr.appendChild(th("№", "rank"));
    hr.appendChild(th("Ученик", "left"));
    hr.appendChild(th("Очки", "c-score"));
    hr.appendChild(th("Задачи", "c-tasks"));
    hr.appendChild(th("Ср. балл", "c-avg"));
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
  function conduitTables(problems, rows, cellFor, footFor, countFor) {
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
      var cell = el("th");
      var box = el("div", "phead");
      box.appendChild(el("div", "phead-id" + (leaf ? "" : " untyped"), p.id));
      var rule = el("div", "phead-rule");
      // без темы — серая полоска: задача видна, но в рейтинг не идёт
      rule.style.background = leaf ? "var(--s" + leaf.slot + ")" : "var(--axis)";
      box.appendChild(rule);
      cell.appendChild(box);
      hr.appendChild(cell);
    });
    hr.appendChild(el("th", "pcount", "всего"));
    thead.appendChild(hr);
    cells.appendChild(thead);

    var total = 0;
    var tbody = el("tbody");
    rows.forEach(function (r) {
      var tr = el("tr", "crow");
      problems.forEach(function (p) {
        var td = el("td", "cell");
        td.appendChild(cellFor(p, r));
        tr.appendChild(td);
      });
      var n = countFor(r);
      total += n;
      tr.appendChild(el("td", "pcount rowcount", n));
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
    f1.appendChild(el("td", "pcount total", total));
    f2.appendChild(el("td", "pcount"));
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
      none.appendChild(el("div", "section-title", "Дней пока нет"));
      host.appendChild(none);
      return;
    }

    var picker = el("div", "card");

    // до первого дня строка выбора пуста — показывать её незачем
    if (DATA.series.length) {
      var r1 = el("div", "filter-row");
      var head = el("div", "filter-head");
      head.appendChild(el("span", "filter-title", "День"));
      r1.appendChild(head);
      var chips = el("div", "chips");
      DATA.series.forEach(function (s) {
        chips.appendChild(dayChip(s, s.n === state.openSeries, "pick", function () {
          state.openSeries = s.n;
          render();
        }));
      });
      r1.appendChild(chips);
      picker.appendChild(r1);
    }

    /* Гробарий — не день смены, поэтому стоит отдельной строкой, а не в их ряду.
       Пустого не показываем: кнопка вела бы на «гробов пока нет». */
    if (graves().length) {
      var r2 = el("div", "filter-row");
      var gb = el("button", "chip day wide");
      gb.type = "button";
      gb.setAttribute("aria-pressed", state.openSeries === GRAVES ? "true" : "false");
      gb.appendChild(el("b", null, "Гробарий"));
      gb.addEventListener("click", function () {
        state.openSeries = GRAVES;
        render();
      });
      r2.appendChild(gb);
      picker.appendChild(r2);
    }

    host.appendChild(picker);

    if (state.openSeries === GRAVES) return viewGraveList(host);

    var s = DATA.series.filter(function (x) { return x.n === state.openSeries; })[0];
    if (!s) return;

    var kind = dayKind(s);
    var sh = el("div", "section-head");
    sh.appendChild(el("span", "section-title",
      kind === "series" ? "Серия " + seriesNo(s) : DAY_NAME[kind]));
    sh.appendChild(el("span", "section-note", prettyDate(s.date)));
    host.appendChild(sh);

    // в выходной и в матбой кондуита нет — показываем только сам день
    if (kind !== "series" || !s.problems.length) return;

    var byId = {};
    UNITS.forEach(function (u) { if (u.sn === s.n) byId[u.id] = u; });

    var order = byName(computeRating(new Set([s.n]), allLeaves(), ALL_KINDS).rows);

    host.appendChild(conduitTables(s.problems, order, function (p, r) {
      return byId[p.id].solverSet.has(r.id) ? el("div", "mark on", "+") : el("div", "mark");
    }, function (p) {
      return [byId[p.id].solvers.length, byId[p.id].weight];
    }, function (r) {
      return s.problems.filter(function (p) {
        return byId[p.id].solverSet.has(r.id);
      }).length;
    }));
  }

  // порядок по номеру: файл обычно уже отсортирован, но полагаться на это незачем
  function graveNum(id) {
    var m = String(id).match(/(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  /* Гробарий — списком, а не сеткой. Гробы штучные: сетка «ученики × гробы»
     стоит почти пустой, и в клетке «+» негде показать надбавку за решение.

     Стоят все гробы подряд, взятые и нет: гробарий — это ещё и объявление,
     что вообще лежит нерешённым, а тема у каждого говорит, за что браться. */
  function viewGraveList(host) {
    var list = graves();
    if (!list.length) {
      var none = el("div", "card");
      none.appendChild(el("div", "section-title", "Гробов пока нет"));
      host.appendChild(none);
      return;
    }

    var byId = {};
    UNITS.forEach(function (u) { if (u.kind === "grave") byId[u.id] = u; });

    var student = {};
    DATA.students.forEach(function (s) { student[s.id] = s; });

    var sh = el("div", "section-head");
    sh.appendChild(el("span", "section-title", "Гробарий"));
    host.appendChild(sh);

    var card = el("div", "card");
    list.slice().sort(function (a, b) {
      return graveNum(a.id) - graveNum(b.id);
    }).forEach(function (p) {
      var u = byId[p.id];
      var leaf = LEAF[leafKey(p.type, p.sub)];

      var block = el("div", "tblock");

      var head = el("div", "grave-head");
      head.appendChild(el("b", "grave-num", p.id));
      var theme = el("span", "grave-theme");
      var d = el("span", "dot");
      // без темы — серый кружок: гроб виден, но в рейтинг не идёт
      d.style.background = leaf ? "var(--s" + leaf.slot + ")" : "var(--axis)";
      theme.appendChild(d);
      theme.appendChild(document.createTextNode(leaf ? leaf.label : "без темы"));
      head.appendChild(theme);
      block.appendChild(head);

      if (u.solvers.length) {
        byName(u.solvers.map(function (sid) { return student[sid]; }))
          .forEach(function (st) { block.appendChild(graveLine(st, u)); });
      } else {
        // цену нерешённого не пишем: она сложится, только когда его возьмут
        block.appendChild(el("div", "block-none", "пока никто"));
      }

      card.appendChild(block);
    });
    host.appendChild(card);
  }

  /* Строка решения: кто взял и сколько это принесло. Надбавку показываем
     слагаемым — иначе 31 у одного и 23 у другого за один и тот же гроб
     выглядели бы опечаткой. */
  function graveLine(st, u) {
    var line = el("div", "grave-line");
    line.appendChild(nameCell("span", "grave-who", st));

    var extra = (u.bonus && u.bonus[st.id]) || 0;
    var val = el("span", "grave-val");
    if (extra) {
      val.appendChild(el("i", "grave-sum", "+" + num(u.weight) + " +" + num(extra) + " ="));
      val.appendChild(document.createTextNode(" " + num(u.weight + extra)));
    } else {
      val.appendChild(document.createTextNode("+" + num(u.weight)));
    }
    line.appendChild(val);
    return line;
  }

  // ── вид: ликбезы ────────────────────────────────────────

  /* Список файлов и больше ничего: сюда заходят с одной целью — забрать pdf,
     поэтому вся строка и есть кнопка скачивания. */
  function viewLikbez(host) {
    var items = likbez();
    if (!items.length) {
      var none = el("div", "card");
      none.appendChild(el("div", "section-title", "Ликбезов пока нет"));
      host.appendChild(none);
      return;
    }

    /* В офлайн-копии файлов нет: она собрана одной страницей, класть в неё
       десятки мегабайт pdf незачем. Названия оставляем — по ним видно, что
       искать на сайте, — но ссылками не притворяемся. */
    var offline = !!DATA.config.offline_date;

    var card = el("div", "card");
    items.forEach(function (it) {
      var row = el(offline ? "div" : "a", "lik-row" + (offline ? " off" : ""));
      if (!offline) {
        row.href = "data/likbez/" + encodeURIComponent(it.file);
        // без этого телефон открывает pdf во вкладке, а его просили скачать
        row.setAttribute("download", it.title + ".pdf");
      }

      var main = el("span", "lik-main");
      main.appendChild(el("span", "lik-title", it.title));
      main.appendChild(el("span", "lik-meta",
        offline ? "нет в офлайн-копии" : "PDF" +
          (fileSize(it.size) ? " · " + fileSize(it.size) : "")));
      row.appendChild(main);

      if (!offline) row.appendChild(el("span", "lik-get", "скачать"));
      card.appendChild(row);
    });
    host.appendChild(card);
  }

  // ── вид: ученики ────────────────────────────────────────

  function viewStudentCard(host, id) {
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

    // половина задач — рубеж, который стоит отметить
    var share = f.available ? row.pluses / f.available : 0;
    var pctTile = tile("Процент", pct(share), null);
    if (share >= 0.5) pctTile.className = "tile hi";
    tiles.appendChild(pctTile);

    var best = bestProblem(id);
    tiles.appendChild(tile("Самый ценный плюс", best ? "+" + best.value : "—",
      best ? (best.u.sn === null ? "гроб " + best.u.id
        : "серия " + seriesNoBySlot(best.u.sn) + ", задача " + best.u.id) : null));
    host.appendChild(tiles);

    var sh2 = el("div", "section-head");
    sh2.appendChild(el("span", "section-title", "По темам"));
    host.appendChild(sh2);

    var card = el("div", "card");
    DATA.types.forEach(function (t) {
      var leaves = catLeaves(t.id);
      if (!leaves.length) return;

      var catStat = statFor(leaves.map(function (l) { return l.key; }), id);
      if (!catStat.total) return;   // тема без задач ничего не говорит

      var block = el("div", "tblock");
      block.appendChild(statLine(t.name, dot(t.slot), catStat, t.slot, false));

      if (leaves.length > 1 || leaves[0].subName) {
        leaves.forEach(function (l) {
          var st = statFor([l.key], id);
          if (!st.total) return;
          block.appendChild(statLine(l.subName || t.name, null, st, t.slot, true));
        });
      }

      card.appendChild(block);
    });
    host.appendChild(card);

    // гробы — списком: их немного, и каждый стоит дорого
    if (graves().length) {
      var sh3 = el("div", "section-head");
      sh3.appendChild(el("span", "section-title", "Гробы"));
      host.appendChild(sh3);

      var box = el("div", "series-mini");
      var mine = UNITS.filter(function (u) {
        return u.kind === "grave" && u.solverSet.has(id);
      });
      if (mine.length) {
        mine.forEach(function (u) {
          var chip = el("span", "smini");
          chip.appendChild(el("b", null, u.id));
          chip.appendChild(document.createTextNode(" +" + unitValue(u, id)));
          box.appendChild(chip);
        });
      } else {
        box.appendChild(el("span", "muted", "—"));
      }
      host.appendChild(box);
    }

    // пока серий нет, таблица по дням — одна шапка; показывать нечего
    if (realSeries().length) {
      var sh4 = el("div", "section-head");
      sh4.appendChild(el("span", "section-title", "По дням"));
      host.appendChild(sh4);
      host.appendChild(seriesBlocks(id));
    }

    var sign = signature(id);
    if (sign) host.appendChild(el("div", "egg", sign));
  }

  /* Строка «название — шкала — сколько из скольких». Ширины колонок заданы
     жёстко, чтобы шкала стояла на одном месте независимо от длины названия;
     у подтемы шкала мельче, но начинается там же. */
  function statLine(name, mark, stat, slot, small) {
    var line = el("div", "pline" + (small ? " sub" : ""));

    var label = el("span", "pline-name");
    if (mark) label.appendChild(mark);
    label.appendChild(document.createTextNode(name));
    line.appendChild(label);

    line.appendChild(meter(stat.total ? stat.got / stat.total : 0, slot, small));
    line.appendChild(el("span", "pline-val", stat.got + "/" + stat.total));
    return line;
  }

  /* По дням — что именно взято в каждой серии. Раньше тут стояли одни итоги;
     номера задач говорят больше: видно, дорогие задачи человек берёт или много
     дешёвых, и какая серия ему не далась. Итоги остались в шапке дня. */
  function seriesBlocks(id) {
    var card = el("div", "card");

    realSeries().forEach(function (s) {
      var mine = [], total = 0, score = 0, ceiling = 0;
      UNITS.forEach(function (u) {
        if (u.sn !== s.n) return;
        total += 1;
        ceiling += u.weight;
        if (u.solverSet.has(id)) {
          mine.push(u);
          score += unitValue(u, id);
        }
      });

      var block = el("div", "tblock");

      var head = el("div", "dblock-head");
      var name = el("span", "dblock-name", "Серия " + seriesNo(s));
      name.appendChild(el("span", "dblock-date", prettyDate(s.date, true)));
      head.appendChild(name);
      head.appendChild(el("span", "dblock-val",
        mine.length + " / " + total + " · " + num(score) + " / " + num(ceiling)));
      block.appendChild(head);

      if (mine.length) {
        var box = el("div", "series-mini");
        mine.forEach(function (u) {
          var chip = el("span", "smini");
          chip.appendChild(el("b", null, u.id));
          chip.appendChild(document.createTextNode(" +" + unitValue(u, id)));
          box.appendChild(chip);
        });
        block.appendChild(box);
      } else {
        block.appendChild(el("div", "block-none", "ни одной"));
      }

      card.appendChild(block);
    });

    return card;
  }

  function statFor(keys, studentId) {
    var set = new Set(keys);
    var total = 0, got = 0, score = 0;
    UNITS.forEach(function (u) {
      if (u.sn !== null && !state.series.has(u.sn)) return;
      if (!set.has(u.leafKey) || !state.kinds.has(u.kind)) return;
      total += 1;
      if (u.solverSet.has(studentId)) { got += 1; score += u.weight; }
    });
    return { total: total, got: got, score: score };
  }

  /* Шкала набрана мелкими блоками, а не одной заливкой. Причина внешняя: в
     Samsung Internet крупная плоская заливка гаснет, а мелкая — нет; кружок
     темы 9×9 и полоска в кондуите 20×3 приходят нетронутыми, широкая полоса
     решаемости — приглушённой. Побочная польза: долю теперь видно по числу
     закрашенных блоков, а не только по цвету. */
  var METER_STEPS = 10;   // одна шкала на весь сайт: 10 квадратов — это 100%

  function meter(share, slot, small) {
    var box = el("div", "meter" + (small ? " small" : ""));
    var on = Math.round(share * METER_STEPS);
    if (share > 0 && on === 0) on = 1;   // ненулевую долю показываем всегда
    for (var i = 0; i < METER_STEPS; i++) {
      var seg = el("i");
      if (i < on) seg.style.background = "var(--s" + slot + ")";
      box.appendChild(seg);
    }
    return box;
  }

  /* Самый ценный плюс — по тому, сколько он принёс этому ученику: у гроба с
     надбавкой цена своя, и сравнивать голые веса было бы неверно. */
  function bestProblem(id) {
    var best = null;
    UNITS.forEach(function (u) {
      if (!u.solverSet.has(id)) return;
      var v = unitValue(u, id);
      if (!best || v > best.value) best = { u: u, value: v };
    });
    return best;
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
    else if (state.view === "likbez") viewLikbez(main);
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
    DATA.likbez = DATA.likbez || { items: [] };
    DATA.likbez.items = DATA.likbez.items || [];
    DATA.students.sort(function (a, b) { return a.name.localeCompare(b.name, "ru"); });
    // порядок ленты — по датам: номер принадлежит серии, а не дню смены
    DATA.series.sort(function (a, b) {
      return String(a.date).localeCompare(String(b.date)) || a.n - b.n;
    });
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
    /* И список дней тоже: без него страница покажет отряд и гробарий, но
       откроется. Сайт читают дети, чинить его посреди смены некому — пусть
       любая порча данных отнимает часть, а не всё. */
    var days = get("series/manifest.json").catch(function () { return null; });
    // ликбезов может не быть вовсе — это не повод не открыть сайт
    var lik = get("likbez.json").catch(function () { return { items: [] }; });

    return Promise.all([
      get("config.json"), get("types.json"), get("students.json"), days, soft, lik
    ]).then(function (res) {
      var files = res[3] && Array.isArray(res[3].series) ? res[3].series : [];
      /* Пропавший файл дня не должен ронять страницу целиком: раз в списке
         осталась запись без файла, показываем остальные дни, а не пустой
         экран с ошибкой. */
      return Promise.all(files.map(function (f) {
        return get("series/" + f).catch(function () { return null; });
      })).then(function (series) {
        return {
          config: res[0], types: res[1], students: res[2],
          series: series.filter(Boolean), graves: res[4], likbez: res[5]
        };
      });
    });
  }

  /* Отклик на касание сделан классом и анимацией, а не :active. На телефоне
     :active почти не виден: браузер придерживает его, пока не поймёт, что
     касание — не начало прокрутки, и на быстром тапе состояние успевает
     появиться и исчезнуть за несколько миллисекунд. Анимация же, раз начавшись,
     доигрывает до конца независимо от того, как долго держали палец. */
  var TAPPABLE = "button:not(.mark), .chip, a.ghost-btn, a.lik-row, tr.clickable";

  function enableTapFeedback() {
    document.addEventListener("pointerdown", function (e) {
      var node = e.target.closest && e.target.closest(TAPPABLE);
      if (!node || node.disabled) return;
      node.classList.remove("tap");
      void node.offsetWidth;      // перезапуск анимации на повторном касании
      node.classList.add("tap");
    }, { passive: true });
  }

  document.addEventListener("DOMContentLoaded", function () {
    enableTapFeedback();
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
