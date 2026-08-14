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
  var SENT = {};        // "01" -> что сохранено; сайт обновляется не мгновенно
  var GONE = {};        // "01" -> когда удалено; сайт ещё показывает старое

  /* Дни правятся не по одному: state.days держит рабочую копию каждого дня,
     который завели или тронули. Поэтому добавленный день сразу виден в списке,
     а переключение между днями ничего не теряет. state.series — указатель на
     открытую копию, она же лежит в state.days.

     Ключ дня — слот: он же имя файла и он же ключ в state.days. Номер серии
     живёт отдельным полем и слоту не равен: выходной и матбой номера не
     получают, поэтому нумерация серий сплошная, а слоты идут своим чередом. */
  var state = {
    view: "series",
    days: {},           // слот -> рабочая копия дня
    removed: {},        // слот -> подпись дня, помеченного к удалению
    series: null,       // открытый день, он же элемент days
    graves: null,       // правка гробария, пока не сохранена
    typesEdit: null,    // правка тем, пока не сохранена
    busy: false,
    note: "",
    noteKind: "",       // good | bad | ""
    confirmSub: null,
    confirmDelete: false,
    confirmRevert: false,
    confirmProblem: null,   // id задачи, у которой спрошено удаление
    confirmGrave: null,     // то же для гроба
    confirmType: null,      // id раздела, у которого спрошено удаление
    sig: null,              // переключатель подписи; null — не трогали
    wn: null,               // n в формуле очков; null — не трогали
    pickTheme: null,    // id задачи, у которой открыт выбор темы
    pickDate: false,
    pickSolver: null,   // номер гроборешения, у которого открыт выбор ученика
    pickGrave: null,    // то же для выбора гроба
    confirmSolution: null   // гроборешение, у которого спрошено удаление
  };

  /* Что уже отправлено. Нужен потому, что сайт переразворачивается не сразу:
     сравнивать правку с данными сайта нельзя — минуту после сохранения они
     ещё старые, и всё выглядело бы несохранённым. */
  var SAVED = { types: null, graves: null, days: {}, sig: null, wn: null };

  /* Виды дня: обычная серия, выходной и математический бой. Номер есть только
     у серии — это её собственный номер. Выходной и матбой стоят в ленте по
     дате и помечены буквой. */
  var DAY_KINDS = [["series", "Серия"], ["off", "Выходной"], ["battle", "Матбой"]];
  var DAY_NAME = { off: "Выходной", battle: "Математический бой" };
  var DAY_MARK = { off: "В", battle: "М" };

  var tokenDraft = "";  // набранный, но ещё не запомненный токен: живёт до ухода

  var LS_TOKEN = "conduit-token";
  var LS_SENT = "conduit-sent";
  var LS_GONE = "conduit-gone";
  var LS_SAVED_AT = "conduit-saved-at";

  /* Пауза между сохранениями. Держит от случайной очереди отправок: сайт
     переразворачивается около минуты, и частые записи подряд наступают друг
     другу на пятки. Отметка лежит в localStorage, поэтому перезагрузка
     страницы её не обходит. */
  var COOLDOWN = 2 * 60 * 1000;

  function markSaveTime() { lsSet(LS_SAVED_AT, String(Date.now())); }

  function cooldownLeft() {
    var at = Number(lsGet(LS_SAVED_AT, 0));
    if (!at) return 0;
    var left = at + COOLDOWN - Date.now();
    return left > 0 ? left : 0;
  }

  function mmss(ms) {
    var s = Math.ceil(ms / 1000);
    return Math.floor(s / 60) + ":" + pad2(s % 60);
  }
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
          if (res.status === 422) msg = "GitHub не принял файл: " + msg;
          /* Код и путь в конце — чтобы по одному снимку экрана было понятно,
             что именно и на каком файле не прошло. */
          throw new Error(msg + " [" + res.status + " " + path.split("?")[0] + "]");
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
    try { GONE = JSON.parse(lsGet(LS_GONE, "{}")) || {}; } catch (e) { GONE = {}; }
  }

  /* Сайт переразворачивается не мгновенно, поэтому только что сохранённый день
     ещё минуту не виден в данных. Помним, что уехало: иначе «+ день» займёт
     чужой слот, а номер серии выдастся уже занятый. Заодно из этой записи
     рисуется кнопка дня, пока сайт не догнал. */
  function markSent(d) {
    SENT[pad2(d.n)] = {
      at: new Date().toISOString(),
      kind: d.kind || "series",
      series: d.kind === "series" ? seriesNo(d) : null,
      date: d.date
    };
    lsSet(LS_SENT, JSON.stringify(SENT));
  }

  function sentInfo(k) {
    var v = SENT[k];
    return v && typeof v === "object" ? v : {};
  }

  /* Удалённый день исчезает из данных так же не сразу. Пока сайт его показывает,
     кнопка стоит в ленте запертой — иначе день, который только что убрали, снова
     выглядел бы обычным и его можно было бы открыть на правку. */
  function markGone(n) {
    GONE[pad2(n)] = new Date().toISOString();
    lsSet(LS_GONE, JSON.stringify(GONE));
  }

  /* Отметка живёт, пока сайт не догонит, но не дольше получаса: день могли
     удалить с другого устройства, и тогда ждать его появления бессмысленно —
     запертая кнопка осталась бы в ленте навсегда, заняв заодно свой слот. */
  var SENT_LIFE = 30 * 60 * 1000;

  function stale(v) {
    var at = Date.parse(v && typeof v === "object" ? v.at : v);
    return !at || Date.now() - at > SENT_LIFE;
  }

  function pruneSent() {
    var changed = false;
    Object.keys(SENT).forEach(function (k) {
      if (dayBySlot(Number(k)) || stale(SENT[k])) { delete SENT[k]; changed = true; }
    });
    if (changed) lsSet(LS_SENT, JSON.stringify(SENT));

    var gchanged = false;
    Object.keys(GONE).forEach(function (k) {
      if (!dayBySlot(Number(k)) || stale(GONE[k])) { delete GONE[k]; gchanged = true; }
    });
    if (gchanged) lsSet(LS_GONE, JSON.stringify(GONE));
  }

  function dayBySlot(n) {
    return DATA.series.filter(function (s) { return s.n === n; })[0] || null;
  }

  /* Номер серии. У старых файлов отдельного поля нет — там слот и был номером,
     поэтому он и служит запасным значением. */
  function seriesNo(d) {
    return d.series === undefined || d.series === null ? d.n : d.series;
  }

  /* Что написано на кнопке дня: у серии — её номер, у прочих — буква. Номера
     может не быть только у записи о недавно отправленном дне, снятой со старой
     страницы, — там честнее вопрос, чем чужое число. */
  function dayMark(d) {
    var kind = d.kind || "series";
    if (kind !== "series") return DAY_MARK[kind] || "?";
    return d.series === null || d.series === undefined ? "?" : String(d.series);
  }

  function dayLabel(d) {
    var kind = d.kind || "series";
    if (kind === "series") return "Серия " + seriesNo(d);
    return DAY_NAME[kind] + (d.date ? " " + shortDate(d.date) : "");
  }

  // слот — ключ файла, наружу не показывается
  function nextSlot() {
    var max = 0;
    DATA.series.forEach(function (s) { if (s.n > max) max = s.n; });
    Object.keys(state.days).forEach(function (k) { if (Number(k) > max) max = Number(k); });
    Object.keys(SENT).forEach(function (k) { if (Number(k) > max) max = Number(k); });
    Object.keys(GONE).forEach(function (k) { if (Number(k) > max) max = Number(k); });
    return max + 1;
  }

  /* Номера серий идут подряд и не зависят от того, сколько было выходных и
     боёв: они номера не занимают. Удалённые дни из счёта тоже выбывают. */
  function seriesNumbers(exceptSlot) {
    var out = {};
    allDays().forEach(function (d) {
      if (d.removed || d.gone || d.n === exceptSlot) return;
      if ((d.kind || "series") !== "series") return;
      if (d.series === null || d.series === undefined) return;
      out[d.series] = true;
    });
    return out;
  }

  /* Следующий номер — за последним, а не первый свободный: серии идут подряд
     во времени, и новая с номером из старой дыры встала бы посреди списка. */
  function nextSeriesNo(exceptSlot) {
    var max = 0;
    Object.keys(seriesNumbers(exceptSlot)).forEach(function (k) {
      if (Number(k) > max) max = Number(k);
    });
    return max + 1;
  }

  function blankDay(slot) {
    var solved = {};
    DATA.students.forEach(function (st) { solved[st.id] = []; });
    return {
      n: slot, series: nextSeriesNo(slot), date: todayISO(),
      kind: "series", problems: [], solved: solved
    };
  }

  function copyDay(s) {
    var kind = s.kind || "series";
    var d = JSON.parse(JSON.stringify({
      n: s.n,
      // у выходного и матбоя номера нет: запасной ход seriesNo дал бы слот файла
      series: kind === "series" ? seriesNo(s) : null,
      date: s.date, kind: kind,
      problems: s.problems || [], solved: s.solved || {}
    }));
    DATA.students.forEach(function (st) {
      if (!d.solved[st.id]) d.solved[st.id] = [];
    });
    return d;
  }

  /* Открываем рабочую копию. Если её ещё нет — берём с сайта или заводим
     пустую; в обоих случаях копия остаётся в state.days, поэтому правка
     переживает переход на другой день. */
  function workingDay(n) {
    if (!state.days[n]) {
      var s = dayBySlot(n);
      state.days[n] = s ? copyDay(s) : blankDay(n);
    }
    return state.days[n];
  }

  function openSeries(n) {
    state.series = workingDay(n);
    state.note = "";
    state.noteKind = "";
    state.pickTheme = null;
    state.pickDate = false;
    state.confirmDelete = false;
    state.confirmProblem = null;
    render();
  }

  /* Список дней для ленты: и то, что на сайте, и заведённое здесь. Порядок —
     по дате: номера теперь принадлежат сериям и ленту не выстраивают. */
  function allDays() {
    var map = {};
    function entry(d, extra) {
      var kind = d.kind || "series";
      var e = {
        n: d.n, date: d.date, kind: kind,
        series: kind === "series" ? seriesNo(d) : null
      };
      Object.keys(extra || {}).forEach(function (k) { e[k] = extra[k]; });
      return e;
    }

    DATA.series.forEach(function (s) { map[s.n] = entry(s); });
    Object.keys(state.days).forEach(function (k) {
      var d = state.days[k];
      map[d.n] = entry(d, { local: !dayBySlot(d.n) });
    });
    Object.keys(SENT).forEach(function (k) {
      var n = Number(k);
      if (map[n]) return;
      var info = sentInfo(k);
      map[n] = {
        n: n, date: info.date || null, kind: info.kind || "series",
        series: info.series === undefined ? null : info.series, pending: true
      };
    });
    /* Ключи здесь с ведущим нулём («03»), а карта дней — по самому слоту («3»).
       Без Number() день с однозначным слотом не запирался после удаления: его
       можно было открыть и сохранить, то есть создать заново. */
    Object.keys(GONE).forEach(function (k) {
      var n = Number(k);
      if (map[n]) map[n].gone = true;
    });
    Object.keys(state.removed).forEach(function (k) {
      var n = Number(k);
      if (map[n]) map[n].removed = true;
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) {
        return String(a.date || "9999").localeCompare(String(b.date || "9999")) ||
          a.n - b.n;
      });
  }

  function removedNumbers() {
    return Object.keys(state.removed).map(Number)
      .sort(function (a, b) { return a - b; });
  }

  function touch() {
    state.note = "";
    state.noteKind = "";
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

  /* Упражнение — не тема, а вид задания, и отдельной пометки ему не нужно:
     упражнения идут под нулевым номером, так что номер и есть признак.
     Ставится он тем же полем, что и у прочих задач. */
  function isExercise(p) { return numPrefix(p.id) === 0; }

  /* Первая задача дня — упражнение: серия начинается с него. Дальше номера идут
     обычным чередом, а если упражнение не нужно — номер правится вручную. */
  function addProblem() {
    var ps = state.series.problems;
    var max = -1;
    ps.forEach(function (p) {
      var n = numPrefix(p.id);
      if (n > max) max = n;
    });
    var first = types()[0];
    if (!first) return;   // без тем задаче нечего присвоить
    ps.push({
      id: String(max + 1),
      type: first.id,
      sub: first.subs && first.subs.length ? first.subs[0].id : null
    });
    touch();
  }

  // семья пунктов последней задачи: 5 → [5], 5а/5б → [5а, 5б]
  function lastFamily() {
    var ps = state.series.problems;
    if (!ps.length) return [];
    var lastNum = numPrefix(ps[ps.length - 1].id);
    return ps.filter(function (p) { return numPrefix(p.id) === lastNum; });
  }

  // букв ровно шесть: после «е» новый пункт совпал бы с прежним по номеру
  function canAddPart() {
    return lastFamily().length < LETTERS.length;
  }

  function addPart() {
    var ps = state.series.problems;
    if (!ps.length) return addProblem();
    if (!canAddPart()) return;

    var lastNum = numPrefix(ps[ps.length - 1].id);
    var family = lastFamily();
    var sample = family[family.length - 1];

    if (family.length === 1 && String(sample.id) === String(lastNum)) {
      renameProblem(sample.id, lastNum + LETTERS[0]);
      insertAfter(sample, { id: lastNum + LETTERS[1], type: sample.type, sub: sample.sub });
    } else {
      insertAfter(sample, {
        id: lastNum + LETTERS[family.length], type: sample.type, sub: sample.sub
      });
    }
    touch();
  }

  function insertAfter(anchor, item) {
    var i = state.series.problems.indexOf(anchor);
    state.series.problems.splice(i === -1 ? state.series.problems.length : i + 1, 0, item);
  }

  function validate(d) {
    d = d || state.series;
    if (!d) return "нечего сохранять";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return "не указана дата";
    if (d.kind !== "series") return null;   // в выходной и в матбой задач нет
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

  // то, что уедет в файл: по нему же определяется, изменился ли день
  function dayPayload(d) {
    var plain = (d.kind || "series") !== "series";   // выходной и матбой без задач
    var payload = {
      n: d.n,
      series: plain ? null : seriesNo(d),
      date: d.date,
      kind: d.kind || "series",
      title: plain ? DAY_NAME[d.kind] : "Серия " + seriesNo(d),
      problems: plain ? [] : (d.problems || []).map(function (p) {
        return {
          id: String(p.id).trim(),
          type: p.type,
          sub: p.sub || null,
          exercise: isExercise(p)
        };
      }),
      solved: {}
    };
    DATA.students.forEach(function (s) {
      payload.solved[s.id] = plain
        ? [] : ((d.solved || {})[s.id] || []).slice().sort(cmpIds);
    });
    return payload;
  }

  function dayDirty(d) {
    var now = JSON.stringify(dayPayload(d));
    if (SAVED.days[d.n]) return now !== SAVED.days[d.n];
    var s = dayBySlot(d.n);
    return !s || now !== JSON.stringify(dayPayload(s));
  }

  function dirtyDays() {
    return Object.keys(state.days)
      .map(function (k) { return state.days[k]; })
      .filter(dayDirty)
      .sort(function (a, b) {
        return String(a.date).localeCompare(String(b.date)) || a.n - b.n;
      });
  }

  /* Отправка одного файла. Ничего не рисует и не переключает состояние занятости
     — этим ведает saveAll: за одно нажатие может уехать несколько дней, гробарий
     и темы. */
  function putDayFile(d) {
    return function () {
      var file = "data/series/" + pad2(d.n) + ".json";
      var payload = dayPayload(d);
      var plain = payload.kind !== "series";
      var pluses = DATA.students.reduce(function (a, s) {
        return a + payload.solved[s.id].length;
      }, 0);

      /* День, о котором редактор не знает, но файл под его именем есть, — это
         всегда чужие данные: список дней не прочитался, или страница открыта со
         старым списком. Записать поверх — потерять день целиком, поэтому
         отказываемся. Свой день узнаётся по данным сайта, по отметке отправки
         или по тому, что мы уже писали его в этот заход. */
      var known = !!dayBySlot(d.n) || !!SENT[pad2(d.n)] || !!SAVED.days[d.n];

      return getFile(file)
        .then(function (cur) {
          if (cur && !known) {
            throw new Error("файл " + pad2(d.n) +
              ".json уже есть в репозитории — обнови страницу");
          }
          return putFile(file, JSON.stringify(payload, null, 2) + "\n",
            plain
              ? DAY_NAME[payload.kind] + " (" + shortDate(d.date) + ")"
              : "Серия " + seriesNo(d) + " (" + shortDate(d.date) + "): " +
                withNum(payload.problems.length, "задача", "задачи", "задач") + ", " +
                withNum(pluses, "плюс", "плюса", "плюсов"),
            cur && cur.sha);
        })
        .then(function () {
          markSent(d);
          SAVED.days[d.n] = JSON.stringify(payload);
        });
    };
  }

  /* Одна кнопка на всё несохранённое. Порядок важен: темы уходят первыми,
     иначе задача с новым подразделом попадёт на сайт раньше подраздела. */
  function saveAll() {
    if (state.busy) return;
    if (!TOKEN) return needToken();

    if (cooldownLeft() > 0) return;

    var days = dirtyDays();
    var gone = removedNumbers();
    var jobs = [];
    if (typesDirty()) jobs.push(putTypesFile);
    days.forEach(function (d) { jobs.push(putDayFile(d)); });
    gone.forEach(function (n) { jobs.push(dropDayFile(n)); });
    if (gravesDirty()) jobs.push(putGravesFile);
    if (configDirty()) jobs.push(putConfigFile);
    if (!jobs.length) return;

    // список дней правим последним и одной записью
    jobs.push(function () {
      return syncManifest(
        days.map(function (d) { return pad2(d.n) + ".json"; }),
        gone.map(function (n) { return pad2(n) + ".json"; })
      ).then(function () {
        /* Пометка удаления снимается только теперь. Раньше её снимало само
           удаление файла — и если запись списка потом срывалась, о висячей
           строке никто уже не помнил. */
        gone.forEach(function (n) { delete state.removed[n]; });
      });
    });

    state.busy = true;
    state.note = "";
    state.noteKind = "";
    render();

    jobs.reduce(function (chain, job) {
      return chain.then(job);
    }, Promise.resolve())
      .then(function () {
        state.busy = false;
        state.note = "Сохранено";
        state.noteKind = "good";
        markSaveTime();
        return reload();
      })
      .catch(function (err) {
        state.busy = false;
        state.note = "Не сохранилось: " + err.message;
        state.noteKind = "bad";
        render();
      });
  }

  /* Удаление файла дня. Как и запись, происходит только по кнопке сохранения:
     до неё день лишь помечен к удалению и вычеркнут в ленте. После удаления
     день ещё минуту виден в данных сайта — на это время он запирается, как
     только что сохранённый, и исчезает сам, когда сайт догонит. */
  function dropDayFile(n) {
    return function () {
      var file = "data/series/" + pad2(n) + ".json";
      var label = state.removed[n];
      return getFile(file).then(function (cur) {
        if (!cur) return null;
        return api("/contents/" + file, {
          method: "DELETE",
          body: JSON.stringify({
            message: (typeof label === "string" ? label : "День") + " — удалено",
            sha: cur.sha,
            branch: repo().branch || "main"
          })
        });
      }).then(function () {
        delete SENT[pad2(n)];
        lsSet(LS_SENT, JSON.stringify(SENT));
        markGone(n);
        delete state.days[n];
        delete SAVED.days[n];
      });
    };
  }

  var MANIFEST = "data/series/manifest.json";

  /* Список дней разбирается строго. Раньше нечитаемый список молча считался
     пустым, и следующая же запись оставила бы в нём один файл — то есть стёрла
     бы с сайта все остальные дни. Лучше отказать с внятной причиной. */
  function readManifest(cur) {
    if (!cur) return [];
    var list;
    try { list = JSON.parse(cur.text).series; } catch (e) { list = null; }
    if (!Array.isArray(list)) {
      throw new Error("список дней (manifest.json) испорчен — правь его вручную");
    }
    return list.slice();
  }

  /* Настоящий список файлов дня — из самого репозитория. Считать список по
     памяти страницы нельзя: любая осечка (не прошла запись, оборвалась связь,
     правили с двух устройств) навсегда оставляла в нём либо лишнюю строку, либо
     дыру, а вычислить это заново было неоткуда. */
  function listSeriesFiles() {
    return api("/contents/data/series?ref=" + (repo().branch || "main"))
      .then(function (list) {
        if (!Array.isArray(list)) throw new Error("не читается папка data/series");
        return list.filter(function (f) {
          return f.type === "file" && /^\d+\.json$/.test(f.name);
        }).map(function (f) { return f.name; });
      });
  }

  /* Список дней пишется один раз за сохранение и целиком: он равен тому, что
     лежит в папке. Только что записанное добавляется, только что удалённое
     вычитается — на случай, если GitHub отдаст ещё не обновившуюся папку (после
     записи он какое-то время показывает прежнее состояние; отсюда и были
     когда-то день без строки в списке, и строка без файла).

     Из-за этого же порядок самолечащийся: любое прошлое расхождение уходит при
     ближайшем сохранении, даже если о нём никто не помнит.

     Одна попытка повтора — на случай устаревшей метки версии. */
  function syncManifest(add, drop, retry) {
    return listSeriesFiles().then(function (files) {
      var next = files.filter(function (f) { return drop.indexOf(f) === -1; });
      add.forEach(function (f) { if (next.indexOf(f) === -1) next.push(f); });
      next.sort();

      return getFile(MANIFEST).then(function (cur) {
        var list = readManifest(cur);
        if (JSON.stringify(next) === JSON.stringify(list)) return null;

        /* Пустой список равносилен стёртому сайту. Своим ходом он получиться
           не может: если дни не удаляли, а считать нечего — что-то не так с
           ответом GitHub, и писать это в репозиторий нельзя. */
        if (!next.length && list.length && !drop.length) {
          throw new Error("список дней вышел пустым — сохранение отменено");
        }

        return putFile(MANIFEST, JSON.stringify({ series: next }, null, 2) + "\n",
          "Список дней обновлён", cur && cur.sha)
          .catch(function (err) {
            if (retry || !/изменился на сервере/.test(err.message)) throw err;
            return syncManifest(add, drop, true);
          });
      });
    });
  }

  /* Настройки сайта живут в data/config.json — значит, видны всем и переживают
     перезагрузку страницы. Файл читается заново перед записью и меняется
     точечно: в нём же лежит отметка сборки, и затирать её правкой со старой
     страницы нельзя. */
  function sigOn() {
    if (state.sig !== null) return state.sig;
    if (SAVED.sig !== null) return SAVED.sig;
    return !!(DATA.config.signature && DATA.config.signature.on);
  }

  function sigDirty() {
    if (state.sig === null) return false;
    var was = SAVED.sig !== null
      ? SAVED.sig : !!(DATA.config.signature && DATA.config.signature.on);
    return state.sig !== was;
  }

  /* n в формуле «вес задачи = n − число решивших». По умолчанию это число
     учеников на смене: задачу, которую сдали все, тогда никто не считает за
     достижение, а задача-одиночка стоит почти в цену отряда. */
  function defaultN() {
    var t = DATA.config.students_total;
    return typeof t === "number" && t > 0 ? t : DATA.students.length;
  }

  function configN() {
    var n = DATA.config.scoring && DATA.config.scoring.n;
    return typeof n === "number" && n > 0 ? n : defaultN();
  }

  function wnValue() {
    if (state.wn !== null) return state.wn;
    if (SAVED.wn !== null) return SAVED.wn;
    return configN();
  }

  /* Ниже одного очка вес не опускается — то же правило, что и на сайте. Задачу,
     которую взяли все, обнулять не за что: она была решена, просто всеми. */
  function weightOf(k) { return Math.max(wnValue() - k, 1); }

  function wnDirty() {
    if (state.wn === null) return false;
    return state.wn !== (SAVED.wn !== null ? SAVED.wn : configN());
  }

  function configDirty() { return sigDirty() || wnDirty(); }

  /* Пишем только то, что правили. Обе настройки разом писать нельзя: значение
     нетронутой берётся из памяти страницы, а она устаревает — правка одной
     настройки откатывала бы чужое изменение другой. */
  function putConfigFile() {
    var sig = state.sig;
    var n = state.wn;
    var wantSig = sigDirty();
    var wantN = wnDirty();
    var what = [];
    if (wantN) what.push("очки: n = " + n);
    if (wantSig) what.push(sig ? "подпись включена" : "подпись выключена");

    return getFile("data/config.json").then(function (cur) {
      if (!cur) throw new Error("нет data/config.json");
      var cfg = JSON.parse(cur.text);
      if (wantSig) {
        cfg.signature = cfg.signature || {};
        cfg.signature.on = sig;
      }
      if (wantN) {
        cfg.scoring = cfg.scoring || {};
        cfg.scoring.n = n;
      }
      return putFile("data/config.json", JSON.stringify(cfg, null, 2) + "\n",
        "Настройки: " + what.join(", "), cur.sha);
    }).then(function () {
      if (wantSig) SAVED.sig = sig;
      if (wantN) SAVED.wn = n;
    });
  }

  function needToken() {
    state.view = "save";
    state.note = "Нужен токен";
    state.noteKind = "bad";
    render();
  }

  // ── гробарий ────────────────────────────────────────────

  /* Гробы живут отдельным файлом: они не привязаны ко дню, копятся всю смену
     и на сайте включаются в рейтинг отдельным переключателем. Номер всегда
     «Гn» — поэтому он не редактируется, а выдаётся следующим свободным.

     Кто что взял — не сетка «ученики × гробы», а отдельные записи. Гробы дело
     штучное: сетка под них стоит почти пустой, и надбавку за конкретное
     решение в клетке «+» показать негде. */

  /* Предел надбавки — не правило смены, а страховка от зажатой кнопки:
     столько нажатий подряд не бывает. */
  var BONUS_MAX = 9999;

  function ensureGraves() {
    if (!state.graves) {
      state.graves = {
        problems: JSON.parse(JSON.stringify((DATA.graves || {}).problems || [])),
        solutions: readSolutions(DATA.graves)
      };
    }
    return state.graves;
  }

  /* У файлов, записанных до разделения, вместо списка решений лежит карта
     solved: читаем и её, иначе первое же сохранение стёрло бы старые плюсы. */
  function readSolutions(g) {
    g = g || {};
    if (Array.isArray(g.solutions)) {
      return g.solutions.map(function (s) {
        return {
          student: s.student || null,
          problem: s.problem || null,
          bonus: solutionBonus(s)
        };
      });
    }
    var out = [];
    Object.keys(g.solved || {}).forEach(function (sid) {
      (g.solved[sid] || []).forEach(function (pid) {
        out.push({ student: sid, problem: pid, bonus: 0 });
      });
    });
    return out;
  }

  /* Надбавка ставится за само решение и прибавляется к цене гроба. Ниже нуля
     не бывает: это надбавка, а не штраф. */
  function solutionBonus(s) {
    var v = s && s.bonus;
    return typeof v === "number" && isFinite(v) && v > 0
      ? Math.min(Math.round(v), BONUS_MAX) : 0;
  }

  function graveNum(id) {
    var m = String(id).match(/(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  function cmpGraves(a, b) { return graveNum(a) - graveNum(b); }

  function sortGraves() {
    ensureGraves().problems.sort(function (a, b) { return cmpGraves(a.id, b.id); });
  }

  function renameGrave(oldId, newId) {
    var g = ensureGraves();
    g.problems.forEach(function (p) { if (p.id === oldId) p.id = newId; });
    g.solutions.forEach(function (s) { if (s.problem === oldId) s.problem = newId; });
  }

  /* Решения пишем по порядку гробов, внутри гроба — по алфавиту. Порядок в
     файле от порядка нажатий тогда не зависит, и в истории видно правку, а не
     перетасовку. Незаполненные записи наружу не уходят. */
  function gravesPayload(g) {
    var name = {};
    DATA.students.forEach(function (s) { name[s.id] = s.name; });

    var list = readSolutions(g).filter(function (s) {
      return s.student && s.problem;
    }).map(function (s) {
      return { student: s.student, problem: s.problem, bonus: solutionBonus(s) };
    });

    list.sort(function (a, b) {
      return cmpGraves(a.problem, b.problem) ||
        String(name[a.student] || a.student)
          .localeCompare(String(name[b.student] || b.student), "ru");
    });

    return {
      problems: (((g && g.problems) || [])).map(function (p) {
        return { id: p.id, type: p.type, sub: p.sub || null };
      }),
      solutions: list
    };
  }

  function gravesDirty() {
    if (!state.graves) return false;
    return JSON.stringify(gravesPayload(state.graves)) !==
      (SAVED.graves || JSON.stringify(gravesPayload(DATA.graves)));
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
    if (!first) return;   // без тем задаче нечего присвоить
    g.problems.push({
      id: "Г" + (max + 1),
      type: first.id,
      sub: first.subs && first.subs.length ? first.subs[0].id : null
    });
    sortGraves();
    touchGraves();
  }

  function removeGrave(id) {
    var g = ensureGraves();
    g.problems = g.problems.filter(function (p) { return p.id !== id; });
    // решения удалённого гроба уходят с ним: без задачи они ничего не значат
    g.solutions = g.solutions.filter(function (s) { return s.problem !== id; });
    touchGraves();
  }

  // ── гроборешения ────────────────────────────────────────

  function solutions() { return ensureGraves().solutions; }

  function studentById(id) {
    return DATA.students.filter(function (s) { return s.id === id; })[0] || null;
  }

  function graveById(id) {
    return ensureGraves().problems.filter(function (p) { return p.id === id; })[0] || null;
  }

  // сколько человек взяло гроб — от этого его цена и зависит
  function graveSolvers(id) {
    return solutions().filter(function (s) { return s.problem === id; }).length;
  }

  // цена гроба считается той же формулой, что и у задачи серии
  function gravePrice(id) { return weightOf(graveSolvers(id)); }

  function solutionValue(s) {
    return s.problem ? gravePrice(s.problem) + solutionBonus(s) : 0;
  }

  /* Пустая запись: ни ученика, ни гроба. Подставлять первых попавшихся нельзя —
     это утверждение о том, кто что решил, и делать его должен человек. Пока
     запись не заполнена, вкладка сохранения её не выпустит. */
  function addSolution() {
    solutions().push({ student: null, problem: null, bonus: 0 });
    touchGraves();
  }

  function removeSolution(i) {
    solutions().splice(i, 1);
    state.confirmSolution = null;
    state.pickSolver = null;
    state.pickGrave = null;
    touchGraves();
  }

  /* Дважды одно и то же решение не записывается: это и лишний плюс в рейтинге,
     и лишний решивший, от которого сам гроб подешевел бы. */
  function solutionTaken(sid, pid, except) {
    return solutions().some(function (s, i) {
      return i !== except && s.student === sid && s.problem === pid;
    });
  }

  function unfilledSolutions() {
    return solutions().filter(function (s) { return !s.student || !s.problem; }).length;
  }

  function putGravesFile() {
    var payload = gravesPayload(state.graves);

    return getFile("data/graves.json").then(function (cur) {
      return putFile("data/graves.json", JSON.stringify(payload, null, 2) + "\n",
        "Гробарий: " + withNum(payload.problems.length, "гроб", "гроба", "гробов") +
        ", " + withNum(payload.solutions.length, "решение", "решения", "решений"),
        cur && cur.sha);
    }).then(function () { SAVED.graves = JSON.stringify(payload); });
  }

  function viewGraves(host) {
    // не прочитался — не показываем пустой список: правка ушла бы поверх него
    if (!DATA.gravesOk) return host.appendChild(brokenCard("гробарий"));

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

    var sh = el("div", "section-head");
    sh.appendChild(el("span", "section-title", "Кто решил"));
    host.appendChild(sh);

    if (!g.problems.length) {
      var none = el("div", "card");
      none.appendChild(el("div", "summary", "Сначала заведи гроб — решать пока нечего."));
      host.appendChild(none);
      return;
    }

    var scard = el("div", "card");
    g.solutions.forEach(function (s, i) { scard.appendChild(solutionBlock(s, i)); });

    var sact = el("div", "frow gap");
    sact.appendChild(button("+ гроборешение", "ghost-btn", function () {
      addSolution();
      render();
    }));
    scard.appendChild(sact);
    host.appendChild(scard);

    if (g.solutions.length) {
      var total = g.solutions.reduce(function (a, s) { return a + solutionValue(s); }, 0);
      host.appendChild(el("div", "summary",
        withNum(g.solutions.length, "решение", "решения", "решений") +
        ", " + withNum(total, "очко", "очка", "очков")));
    }
  }

  /* Блок гроборешения: кто, какой гроб и надбавка за него. Всё выбирается
     своими списками — системных полей на этой странице нет. */
  function solutionBlock(s, i) {
    var block = el("div", "tblock");

    var whoOpen = state.pickSolver === i;
    var whatOpen = state.pickGrave === i;

    var top = el("div", "frow top");
    var st = studentById(s.student);
    top.appendChild(field("Решивший", picker(st ? st.name : "кто?", null, whoOpen,
      function () {
        state.pickSolver = whoOpen ? null : i;
        state.pickGrave = null;
        render();
      })));

    var p = graveById(s.problem);
    var t = p ? typeById(p.type) : null;
    var sub = p ? subOf(t, p) : null;
    var label = p
      ? p.id + (sub ? " · " + sub.name : (t ? " · " + t.name : ""))
      : "какой?";
    top.appendChild(field("Гроб", picker(label,
      p ? (typed(p) ? dot(t.slot) : greyDot()) : null, whatOpen,
      function () {
        state.pickGrave = whatOpen ? null : i;
        state.pickSolver = null;
        render();
      })));
    block.appendChild(top);

    if (whoOpen) block.appendChild(solverChooser(s, i));
    if (whatOpen) block.appendChild(graveChooser(s, i));

    var bottom = el("div", "frow gap");
    bottom.appendChild(field("Надбавка", bonusStepper(s)));
    bottom.appendChild(priceBox(s));
    bottom.appendChild(deleteCell(state.confirmSolution === i, function () {
      state.confirmSolution = i;
      state.pickSolver = null;
      state.pickGrave = null;
      render();
    }, function () {
      removeSolution(i);
      render();
    }));
    block.appendChild(bottom);

    return block;
  }

  function picker(label, mark, open, fn) {
    var b = el("button", "picker-btn" + (open ? " open" : ""));
    b.type = "button";
    var box = el("span", "picker-label");
    if (mark) box.appendChild(mark);
    box.appendChild(document.createTextNode(label));
    b.appendChild(box);
    b.appendChild(el("span", "picker-caret", "▾"));
    b.addEventListener("click", fn);
    return b;
  }

  function solverChooser(s, i) {
    var box = el("div", "chooser");
    var chips = el("div", "chips");
    DATA.students.forEach(function (st) {
      // у кого этот гроб уже записан — второй раз он его не решал
      if (s.problem && solutionTaken(st.id, s.problem, i)) return;
      var b = el("button", "chip pick", st.name);
      b.type = "button";
      b.setAttribute("aria-pressed", st.id === s.student ? "true" : "false");
      b.addEventListener("click", function () {
        s.student = st.id;
        state.pickSolver = null;
        touchGraves();
        render();
      });
      chips.appendChild(b);
    });
    box.appendChild(chips);
    return box;
  }

  function graveChooser(s, i) {
    var box = el("div", "chooser");
    var chips = el("div", "chips");
    ensureGraves().problems.forEach(function (p) {
      if (s.student && solutionTaken(s.student, p.id, i)) return;
      var b = el("button", "chip pick");
      b.type = "button";
      b.setAttribute("aria-pressed", p.id === s.problem ? "true" : "false");
      b.appendChild(typed(p) ? dot(typeById(p.type).slot) : greyDot());
      b.appendChild(document.createTextNode(p.id));
      b.addEventListener("click", function () {
        s.problem = p.id;
        state.pickGrave = null;
        touchGraves();
        render();
      });
      chips.appendChild(b);
    });
    box.appendChild(chips);
    return box;
  }

  /* Надбавка — тот же счётчик, что был у дополнительных баллов: поля для ввода
     числа здесь нет, на телефоне оно неудобно. */
  function bonusStepper(s) {
    var v = solutionBonus(s);
    var step = el("div", "stepper");

    var minus = button("−", "step-btn", function () {
      s.bonus = Math.max(0, v - 1);
      touchGraves();
      render();
    });
    minus.disabled = v <= 0;
    minus.setAttribute("aria-label", "убрать балл надбавки");
    step.appendChild(minus);

    step.appendChild(el("span", "step-val" + (v ? " on" : ""), v));

    var plus = button("+", "step-btn", function () {
      s.bonus = Math.min(BONUS_MAX, v + 1);
      touchGraves();
      render();
    });
    plus.disabled = v >= BONUS_MAX;
    plus.setAttribute("aria-label", "добавить балл надбавки");
    step.appendChild(plus);

    return step;
  }

  /* Цена решения = цена гроба плюс надбавка. Слагаемые показываем: без них
     разные суммы за один и тот же гроб выглядели бы ошибкой счёта. */
  function priceBox(s) {
    var box = el("div", "solution-price");
    if (!s.problem) {
      box.appendChild(el("span", "muted", "гроб не выбран"));
      return box;
    }
    var price = gravePrice(s.problem);
    var extra = solutionBonus(s);
    box.appendChild(el("span", "price-label", "цена"));
    var val = el("span", "price-val");
    if (extra) {
      val.appendChild(el("i", "price-sum", price + " + " + extra + " = "));
      val.appendChild(document.createTextNode(String(price + extra)));
    } else {
      val.appendChild(document.createTextNode(String(price)));
    }
    box.appendChild(val);
    return box;
  }

  function graveRow(p) {
    var asking = state.confirmGrave === p.id;
    var wrap = el("div", "prow-wrap");
    var row = el("div", "prow grave" + (asking ? " asking" : ""));

    /* Правится только число: буква Г стоит рядом как подпись, чтобы не искать
       кириллицу на телефонной клавиатуре. */
    var idBox = el("div", "grave-id");
    idBox.appendChild(el("span", "grave-pre", "Г"));

    var numIn = el("input");
    numIn.className = "input tiny";
    numIn.type = "number";
    numIn.inputMode = "numeric";
    numIn.min = "1";
    numIn.value = graveNum(p.id);
    numIn.addEventListener("change", function () {
      var v = parseInt(numIn.value, 10);
      var id = "Г" + v;
      var taken = ensureGraves().problems.some(function (x) {
        return x !== p && x.id === id;
      });
      if (!v || v < 1 || taken) { numIn.value = graveNum(p.id); return; }
      renameGrave(p.id, id);
      sortGraves();
      touchGraves();
      render();
    });
    idBox.appendChild(numIn);
    row.appendChild(idBox);

    var t = typeById(p.type);
    var sub = subOf(t, p);
    var ok = typed(p);
    var open = state.pickTheme === p.id;

    var pick = el("button", "picker-btn" + (open ? " open" : ""));
    pick.type = "button";
    var label = el("span", "picker-label");
    label.appendChild(ok ? dot(t.slot) : greyDot());
    label.appendChild(document.createTextNode(
      !t ? "тема?" : t.name + (sub ? " · " + sub.name : (ok ? "" : " · ?"))));
    pick.appendChild(label);
    pick.appendChild(el("span", "picker-caret", "▾"));
    pick.addEventListener("click", function () {
      state.pickTheme = open ? null : p.id;
      render();
    });
    row.appendChild(pick);

    row.appendChild(deleteCell(asking, function () {
      state.confirmGrave = p.id;
      state.pickTheme = null;
      render();
    }, function () {
      removeGrave(p.id);
      state.confirmGrave = null;
      render();
    }));

    wrap.appendChild(row);
    if (open) wrap.appendChild(themeChooser(p, touchGraves));
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
    if (!state.typesEdit) return false;
    return JSON.stringify(state.typesEdit) !==
      (SAVED.types || JSON.stringify(DATA.types));
  }

  /* Тема задачи задана правильно, если её подраздел есть в списке тем. После
     удаления подраздела задача остаётся без темы: в кондуите её видно серой,
     в рейтинг она не идёт. */
  function subOf(t, p) {
    return t && (t.subs || []).filter(function (s) { return s.id === p.sub; })[0];
  }

  function typed(p) {
    var t = typeById(p.type);
    if (!t) return false;
    return (t.subs || []).length ? !!subOf(t, p) : !p.sub;
  }

  function putTypesFile() {
    var payload = state.typesEdit;
    return getFile("data/types.json").then(function (cur) {
      return putFile("data/types.json", JSON.stringify(payload, null, 2) + "\n",
        "Темы обновлены", cur && cur.sha);
    }).then(function () { SAVED.types = JSON.stringify(payload); });
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

  /* Только чистый цвет: картинку-градиент Samsung Internet затемняет, плоскую
     заливку — нет. */
  function dot(slot) {
    var d = el("span", "dot");
    d.style.background = "var(--s" + slot + ")";
    return d;
  }

  // задача без темы — серый кружок вместо цвета раздела
  function greyDot() {
    var d = el("span", "dot");
    d.style.background = "var(--axis)";
    return d;
  }

  /* Стрелка «назад» рисуется в svg. Ни шрифтовой символ, ни фигура из рамок
     на телефоне не показывались: у первого не оказалось глифа, вторая терялась
     на дробной толщине. У svg нет ни той, ни другой зависимости. */
  function backArrow() {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "15");
    svg.setAttribute("height", "15");
    svg.setAttribute("aria-hidden", "true");

    var path = document.createElementNS(NS, "path");
    path.setAttribute("d", "M9.5 3.5 5 8l4.5 4.5");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");

    svg.appendChild(path);
    return svg;
  }

  function backButton(fn) {
    var b = el("button", "icon-btn back");
    b.type = "button";
    b.appendChild(backArrow());
    b.addEventListener("click", fn);
    return b;
  }

  /* Что-то из данных не прочиталось. Правку в этом месте не показываем вовсе:
     пустой экран, уехавший в репозиторий, стёр бы настоящие данные. */
  function brokenCard(what) {
    var card = el("div", "card warn");
    card.appendChild(el("div", "warn-title", "Не прочитался " + what));
    card.appendChild(el("div", "warn-line",
      "Обнови страницу. Пока не прочитается — не правим, чтобы не записать пустое."));
    return card;
  }

  function button(text, cls, fn) {
    var b = el("button", cls || "ghost-btn", text);
    b.type = "button";
    b.addEventListener("click", fn);
    return b;
  }

  function field(label, node, cls) {
    var f = el("div", "field" + (cls ? " " + cls : ""));
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
    /* Список дней не прочитался — лента пуста не потому, что дней нет. Заводить
       день в таком состоянии нельзя: он занял бы имя файла существующего дня. */
    if (!DATA.daysOk) return host.appendChild(brokenCard("список дней"));

    var picker = el("div", "card");
    var chips = el("div", "chips");
    allDays().forEach(function (d) {
      if (d.removed) chips.appendChild(removedChip(d));
      else chips.appendChild(dayChip(d));
    });

    /* День заводится этой кнопкой и сразу встаёт в ленту — как подраздел в
       темах. В репозиторий он уедет позже, из вкладки «Сохранение». */
    var add = el("button", "chip day new");
    add.type = "button";
    add.setAttribute("aria-pressed", "false");
    add.appendChild(el("b", null, "+"));
    add.appendChild(el("small", null, "день"));
    add.addEventListener("click", function () { openSeries(nextSlot()); });
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

    /* Номер есть только у серии: выходной и матбой номеров не занимают. Занятый
       номер не принимаем — иначе две серии носили бы один номер. */
    if (state.series.kind === "series") {
      var numInput = el("input");
      numInput.type = "number";
      numInput.inputMode = "numeric";
      numInput.min = "1";
      numInput.value = seriesNo(state.series);
      numInput.className = "input short";
      numInput.addEventListener("change", function () {
        var was = seriesNo(state.series);
        var v = parseInt(numInput.value, 10);
        if (!v || v < 1 || (v !== was && seriesNumbers(state.series.n)[v])) {
          numInput.value = was;
          return;
        }
        state.series.series = v;
        touch();
        render();
      });
      mrow.appendChild(field("Номер серии", numInput, "narrow"));
    }
    mrow.appendChild(field("Дата", dateField()));
    meta.appendChild(mrow);

    // вид дня: серия, выходной или матбой
    var kinds = el("div", "chips");
    DAY_KINDS.forEach(function (pair) {
      var b = el("button", "chip pick", pair[1]);
      b.type = "button";
      b.setAttribute("aria-pressed", state.series.kind === pair[0] ? "true" : "false");
      b.addEventListener("click", function () {
        state.series.kind = pair[0];
        /* Стал серией — нужен номер: у выходного и матбоя его нет, а прежний
           мог уйти другой серии, пока этот день числился выходным. */
        if (pair[0] === "series") {
          var no = state.series.series;
          if (no === null || no === undefined ||
              seriesNumbers(state.series.n)[no]) {
            state.series.series = nextSeriesNo(state.series.n);
          }
        }
        state.confirmProblem = null;
        touch();
        render();
      });
      kinds.appendChild(b);
    });
    meta.appendChild(field("Что было", kinds));

    host.appendChild(meta);

    // в выходной и в матбой задач нет — показывать нечего
    if (state.series.kind === "series") {
      var sh = el("div", "section-head");
      sh.appendChild(el("span", "section-title", "Задачи"));
      host.appendChild(sh);

      var pcard = el("div", "card");
      state.series.problems.forEach(function (p) { pcard.appendChild(problemRow(p)); });

      var actions = el("div", "frow gap");
      actions.appendChild(button("+ задача", "ghost-btn", function () { addProblem(); render(); }));
      var part = button("+ пункт", "ghost-btn", function () { addPart(); render(); });
      // дошли до «е» — дальше пункт совпал бы с уже существующим
      part.disabled = state.series.problems.length > 0 && !canAddPart();
      actions.appendChild(part);
      pcard.appendChild(actions);
      host.appendChild(pcard);

      if (state.series.problems.length) {
        var sh2 = el("div", "section-head");
        sh2.appendChild(el("span", "section-title", "Кондуит"));
        host.appendChild(sh2);
        host.appendChild(conduitGrid(state.series.problems, state.series.solved, touch));
      }
    }

    host.appendChild(deleteBar());
  }

  // вычеркнутый день возвращается повторным касанием — тупика быть не должно
  function removedChip(d) {
    var b = el("button", "chip day gone");
    b.type = "button";
    b.setAttribute("aria-pressed", "false");
    b.appendChild(el("b", null, dayMark(d)));
    b.appendChild(el("small", null, "удалить"));
    b.addEventListener("click", function () {
      delete state.removed[d.n];
      render();
    });
    return b;
  }

  /* Кнопка дня: у серии — её номер, у выходного и матбоя — буква. Дата стоит
     подписью всегда, по ней же лента и выстроена.

     Заперты две кнопки: только что сохранённая и только что удалённая. Обе
     ждут, пока сайт переразвернётся: правка по ним ушла бы мимо данных. */
  function dayChip(d) {
    var kind = d.kind || "series";
    var waiting = d.pending || d.gone;
    var b = el("button", "chip day" + (waiting ? " pending" : "") +
      (kind === "series" ? "" : " " + kind) + (d.local ? " local" : ""));
    b.type = "button";
    b.setAttribute("aria-pressed",
      state.series && state.series.n === d.n ? "true" : "false");
    b.appendChild(el("b", null, dayMark(d)));
    b.appendChild(el("small", null,
      d.gone ? "удалён" : (d.pending && !d.date ? "ждём" : shortDate(d.date))));
    b.addEventListener("click", function () {
      if (waiting) {
        state.note = d.gone ? "День удалён" : "День сохранён";
        state.noteKind = "good";
        return render();
      }
      openSeries(d.n);
    });
    return b;
  }

  /* Удаление дня меняет только экран редактора. День, которого на сайте ещё
     нет, просто выбрасывается из памяти; записанный — помечается к удалению и
     уедет с ближайшим сохранением. */
  function dropDay() {
    var n = state.series.n;
    if (dayBySlot(n)) state.removed[n] = dayLabel(state.series);
    delete state.days[n];
    delete SAVED.days[n];
    state.series = null;
    state.confirmDelete = false;
    lastSeriesN = null;
    render();
  }

  /* Кнопка стоит по центру: слева от неё ничего нет, и прижатая к правому краю
     она смотрелась брошенной. Второе нажатие и есть предупреждение — словами
     оно ничего не добавляет. */
  function deleteBar() {
    var card = el("div", "card savecard center");

    if (state.confirmDelete) {
      card.appendChild(button("Удалить", "primary-btn danger", dropDay));
      card.appendChild(backButton(function () {
        state.confirmDelete = false;
        render();
      }));
    } else {
      card.appendChild(button("Удалить день", "primary-btn danger", function () {
        state.confirmDelete = true;
        render();
      }));
    }
    return card;
  }

  /* Крестик, который спрашивает второй раз: первое нажатие раздваивает его на
     «удалить» и «передумал». Один и тот же для задачи, гроба и подраздела —
     удаление везде необратимо и стоит одинаково дорого. */
  function deleteCell(asking, ask, drop) {
    if (!asking) return button("×", "icon-btn del", ask);
    var box = el("span", "confirm");
    box.appendChild(button("×", "icon-btn danger", drop));
    box.appendChild(backButton(function () {
      state.confirmProblem = null;
      state.confirmGrave = null;
      state.confirmSub = null;
      state.confirmType = null;
      state.confirmSolution = null;
      render();
    }));
    return box;
  }

  function problemRow(p) {
    var asking = state.confirmProblem === p.id;
    var wrap = el("div", "prow-wrap");
    var row = el("div", "prow" + (asking ? " asking" : ""));

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
    var sub = subOf(t, p);
    var ok = typed(p);
    var open = state.pickTheme === p.id;

    var pick = el("button", "picker-btn" + (open ? " open" : ""));
    pick.type = "button";
    var label = el("span", "picker-label");
    label.appendChild(ok ? dot(t.slot) : greyDot());
    if (isExercise(p)) label.appendChild(el("span", "badge", "упр."));
    label.appendChild(document.createTextNode(
      !t ? "тема?" : t.name + (sub ? " · " + sub.name : (ok ? "" : " · ?"))));
    pick.appendChild(label);
    pick.appendChild(el("span", "picker-caret", "▾"));
    pick.addEventListener("click", function () {
      state.pickTheme = open ? null : p.id;
      state.pickDate = false;
      render();
    });
    row.appendChild(pick);

    row.appendChild(deleteCell(asking, function () {
      state.confirmProblem = p.id;
      state.pickTheme = null;
      render();
    }, function () {
      removeProblem(p.id);
      state.confirmProblem = null;
      touch();
      render();
    }));

    wrap.appendChild(row);
    if (open) wrap.appendChild(themeChooser(p, touch));
    return wrap;
  }

  /* Один и тот же выбор темы для задачи серии и для гроба: правка помечает
     разные файлы, отсюда второй параметр. */
  function themeChooser(p, touch) {
    var box = el("div", "chooser");

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
      var cell = el("td", "pname");
      var box = el("span", "name-box");
      box.appendChild(el("span", "nm", st.name));
      if (DATA.config.admin === st.id) box.appendChild(el("i", "badge-admin", "◆"));
      if (leader === st.id) box.appendChild(el("i", "badge-leader"));
      cell.appendChild(box);
      tr.appendChild(cell);
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
      var ok = typed(p);
      var cell = el("th");
      var box = el("div", "phead");
      box.appendChild(el("div", "phead-id" + (ok ? "" : " untyped"), p.id));
      var rule = el("div", "phead-rule");
      rule.style.background = ok ? "var(--s" + t.slot + ")" : "var(--axis)";
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
          b.className = "mark" + (on ? " on pop" : " drop");
          b.textContent = on ? "+" : "";
          setTimeout(function () {
            b.classList.remove(on ? "pop" : "drop");
          }, 260);
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
      f2.appendChild(el("td", "colweight", weightOf(colCount(p.id))));
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
        if (ws[i]) ws[i].textContent = weightOf(n);
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
        var weight = weightOf(solvers.length);
        solvers.forEach(function (st) { score[st.id] += weight; });
      });
    });

    // гробы с надбавками — тоже очки, и на сайте они считаются так же
    var taken = readSolutions(DATA.graves);
    ((DATA.graves && DATA.graves.problems) || []).forEach(function (p) {
      var mine = taken.filter(function (x) { return x.problem === p.id; });
      var weight = weightOf(mine.length);
      mine.forEach(function (x) {
        if (score[x.student] === undefined) return;
        score[x.student] += weight + solutionBonus(x);
      });
    });

    var best = null;
    Object.keys(score).forEach(function (id) {
      if (score[id] > 0 && (!best || score[id] > score[best])) best = id;
    });
    return best;
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

      /* Раздел удаляется целиком, вместе с подразделами: задачи из него
         остаются без темы и в рейтинг не идут, пока им не выберут тему заново.
         Цвет при этом освобождается — им можно красить новый раздел.

         Последний раздел не убираем: задаче всегда нужна тема, а взять её было
         бы неоткуда. */
      if (types().length > 1) {
        head.appendChild(deleteCell(state.confirmType === t.id, function () {
          state.confirmType = t.id;
          render();
        }, function () {
          state.typesEdit = editTypes().filter(function (x) { return x.id !== t.id; });
          state.confirmType = null;
          render();
        }));
      }
      block.appendChild(head);

      (t.subs || []).forEach(function (s) {
        var key = t.id + "/" + s.id;
        var line = el("div", "subline");
        line.appendChild(el("span", "subline-name", s.name));

        /* Задачи удалённого подраздела остаются без темы и выпадают из
           рейтинга, пока им не выберут тему заново. */
        line.appendChild(deleteCell(state.confirmSub === key, function () {
          state.confirmSub = key;
          render();
        }, function () {
          var draft = editTypes();
          var cat = draft.filter(function (x) { return x.id === t.id; })[0];
          cat.subs = cat.subs.filter(function (x) { return x.id !== s.id; });
          state.confirmSub = null;
          render();
        }));
        block.appendChild(line);
      });

      var add = el("div", "frow gap");
      var input = el("input");
      input.className = "input";
      input.placeholder = "новый подраздел";
      add.appendChild(input);
      add.appendChild(button("+", "icon-btn add", function () {
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
    row.appendChild(button("+", "icon-btn add", function () {
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
  }

  // ── вид: сохранение ─────────────────────────────────────

  /* Единственное место, откуда что-либо уезжает в репозиторий. Правки во всех
     вкладках живут в памяти страницы, здесь видно, что накопилось, и одна
     кнопка отправляет всё разом. */
  /* Задачи, у которых подраздела больше нет в списке тем. Они не считаются в
     рейтинге, и молча это заметить нельзя — поэтому список висит здесь, пока
     их не переразметят. Смотрим и записанное на сайте, и открытую правку. */
  function untypedTasks() {
    var found = [];

    // у дня с рабочей копией смотрим копию, у остального — то, что на сайте
    var days = {};
    DATA.series.forEach(function (s) { days[s.n] = s; });
    Object.keys(state.days).forEach(function (k) { days[k] = state.days[k]; });

    Object.keys(days).map(Number).sort(function (a, b) { return a - b; })
      .forEach(function (n) {
        var d = days[n];
        if ((d.kind || "series") !== "series") return;
        var bad = (d.problems || []).filter(function (p) { return !typed(p); });
        if (bad.length) found.push([dayLabel(d), bad]);
      });

    var gr = (state.graves || DATA.graves).problems || [];
    var badGraves = gr.filter(function (p) { return !typed(p); });
    if (badGraves.length) found.push(["Гробарий", badGraves]);

    return found;
  }

  /* Возврат к тому, что на сайте: рабочие копии дней, правка тем и гробария
     просто выбрасываются. Открытый день переоткрывается заново, если он на
     сайте есть, иначе экран остаётся без открытого дня. */
  /* Обратный счёт правит только надпись на кнопке. Перерисовывать весь экран
     раз в секунду нельзя: под кнопкой поле токена, оно теряло бы ввод. */
  var cdTimer = null;

  function countdown(btn, active) {
    clearInterval(cdTimer);
    cdTimer = setInterval(function () {
      var left = cooldownLeft();
      if (left <= 0) {
        clearInterval(cdTimer);
        cdTimer = null;
        btn.textContent = "Сохранить";
        btn.disabled = !active;
        return;
      }
      btn.textContent = mmss(left);
    }, 1000);
  }

  function revertAll() {
    var n = state.series ? state.series.n : null;
    state.days = {};
    state.removed = {};
    SAVED.days = {};
    state.typesEdit = null;
    SAVED.types = null;
    state.graves = null;
    SAVED.graves = null;
    state.series = null;
    state.confirmRevert = false;
    state.confirmSub = null;
    state.confirmProblem = null;
    state.confirmGrave = null;
    state.confirmType = null;
    state.confirmSolution = null;
    state.pickSolver = null;
    state.pickGrave = null;
    state.sig = null;
    SAVED.sig = null;
    state.wn = null;
    SAVED.wn = null;
    lastSeriesN = null;
    if (n !== null && dayBySlot(n)) openSeries(n);
    else render();
  }

  function viewSave(host) {
    var untyped = untypedTasks();
    if (untyped.length) {
      var warn = el("div", "card warn");
      warn.appendChild(el("div", "warn-title", "Задачи без темы — не считаются"));
      untyped.forEach(function (pair) {
        var line = el("div", "warn-line");
        line.appendChild(el("span", "warn-where", pair[0]));
        line.appendChild(el("span", "warn-ids", pair[1].map(function (p) {
          return p.id;
        }).join(", ")));
        warn.appendChild(line);
      });
      host.appendChild(warn);
    }

    var days = dirtyDays();
    var gone = removedNumbers();
    var items = [];
    if (typesDirty()) items.push("Темы");
    days.forEach(function (d) { items.push(dayLabel(d)); });
    gone.forEach(function (n) {
      items.push((state.removed[n] || "День") + " · удалить");
    });
    if (gravesDirty()) items.push("Гробарий");
    if (configDirty()) items.push("Настройки");

    var problem = null;
    for (var i = 0; i < days.length && !problem; i++) {
      var bad = validate(days[i]);
      if (bad) problem = dayLabel(days[i]) + ": " + bad;
    }

    /* Незаполненное гроборешение наружу не выпускаем: запись без ученика или
       без гроба ничего не значит, а молча выбросить её при сохранении — значит
       потерять начатое, ничего не сказав. */
    if (!problem && state.graves) {
      var half = unfilledSolutions();
      if (half) {
        problem = "Гробарий: " +
          withNum(half, "гроборешение не заполнено", "гроборешения не заполнены",
            "гроборешений не заполнено");
      }
    }

    var left = cooldownLeft();
    var card = el("div", "card savecard");
    var main = el("div", "savecard-main");
    main.appendChild(el("div", "savecard-title",
      items.length ? items.join(" · ") : "Изменений нет"));
    if (problem) main.appendChild(el("div", "savecard-note", problem));
    else if (left && items.length) {
      main.appendChild(el("div", "savecard-note", "перерыв между сохранениями"));
    }
    card.appendChild(main);

    var save = button(state.busy ? "…" : (left ? mmss(left) : "Сохранить"),
      "primary-btn", saveAll);
    save.disabled = state.busy || !items.length || !!problem || !!left;
    card.appendChild(save);
    host.appendChild(card);

    if (left) countdown(save, items.length && !problem);

    /* Откат всего несохранённого. Спрашиваем вторым нажатием: правки живут
       только в памяти страницы, вернуть их после отката неоткуда. */
    if (items.length) {
      var rev = el("div", "card savecard center");
      if (state.confirmRevert) {
        rev.appendChild(button("Отменить всё", "primary-btn danger", revertAll));
        rev.appendChild(backButton(function () {
          state.confirmRevert = false;
          render();
        }));
      } else {
        rev.appendChild(button("Отменить изменения", "primary-btn danger", function () {
          state.confirmRevert = true;
          render();
        }));
      }
      host.appendChild(rev);
    }

    var shScore = el("div", "section-head");
    shScore.appendChild(el("span", "section-title", "Очки"));
    host.appendChild(shScore);

    var score = el("div", "card");
    var nIn = el("input");
    nIn.type = "number";
    nIn.inputMode = "numeric";
    /* Меньше числа учеников n быть не может: задача, которую сдали больше n
       человек, весила бы меньше нуля, и плюс за неё отнимал бы очки. */
    var least = defaultN();
    nIn.min = String(least);
    nIn.value = wnValue();
    nIn.className = "input short";
    nIn.addEventListener("change", function () {
      var v = parseInt(nIn.value, 10);
      if (!v || v < least) { nIn.value = wnValue(); return; }
      state.wn = v;
      state.note = "";
      state.noteKind = "";
      render();
    });
    score.appendChild(field("n", nIn));
    score.appendChild(el("div", "savecard-note",
      "вес задачи = n − число решивших, но не меньше 1; само n меньше " +
      least + " не бывает"));
    host.appendChild(score);

    var sh = el("div", "section-head");
    sh.appendChild(el("span", "section-title", "Доступ"));
    host.appendChild(sh);

    var token = el("div", "card");
    var input = el("input");
    input.className = "input";
    input.type = "password";
    input.autocomplete = "off";
    input.placeholder = TOKEN ? "••••••••  (введите, чтобы заменить)" : "github_pat_…";
    /* Набранное держим в памяти: экран перерисовывается от любой кнопки рядом,
       а вставлять длинный токен второй раз — мучение. */
    input.value = tokenDraft;
    input.addEventListener("input", function () { tokenDraft = input.value; });
    token.appendChild(field("Токен", input));

    var row = el("div", "frow gap");
    // не «Сохранить»: эта кнопка ничего не отправляет, а запоминает токен здесь
    row.appendChild(button("Запомнить", "ghost-btn", function () {
      var v = String(input.value).trim();
      if (!v) return;
      TOKEN = v;
      lsSet(LS_TOKEN, v);
      tokenDraft = "";
      input.value = "";
      check();
    }));
    row.appendChild(button("Проверить доступ", "ghost-btn", check));
    row.appendChild(button("Удалить", "ghost-btn", function () {
      TOKEN = null;
      lsDel(LS_TOKEN);
      tokenDraft = "";
      state.note = "Токен удалён";
      state.noteKind = "";
      render();
    }));
    token.appendChild(row);
    host.appendChild(token);

    host.appendChild(eggToggle());
  }

  /* Стоит особняком в самом низу и ничего не подписывает: включённое видно по
     цвету. Как и всё прочее, уезжает только по кнопке сохранения. */
  function eggToggle() {
    var foot = el("div", "footrow");
    var b = el("button", "egg-btn");
    b.type = "button";
    b.setAttribute("aria-pressed", sigOn() ? "true" : "false");
    b.setAttribute("aria-label", "Подпись");

    var NS = "http://www.w3.org/2000/svg";
    /* Значок нарочно ничего не означает: пустой кружок против залитого. */
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("aria-hidden", "true");
    var circle = document.createElementNS(NS, "circle");
    circle.setAttribute("cx", "8");
    circle.setAttribute("cy", "8");
    circle.setAttribute("r", "4.6");
    circle.setAttribute("fill", sigOn() ? "currentColor" : "none");
    circle.setAttribute("stroke", "currentColor");
    circle.setAttribute("stroke-width", "1.6");
    svg.appendChild(circle);
    b.appendChild(svg);

    b.addEventListener("click", function () {
      state.sig = !sigOn();
      state.note = "";
      state.noteKind = "";
      render();
    });
    foot.appendChild(b);
    return foot;
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
    clearInterval(cdTimer);
    cdTimer = null;

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
    else if (state.view === "save") viewSave(main);
  }

  function setupChrome() {
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
      t.addEventListener("click", function () {
        state.view = t.dataset.view;
        state.note = "";
        state.noteKind = "";
        state.confirmSub = null;
        state.confirmProblem = null;
        state.confirmGrave = null;
        state.confirmType = null;
        state.confirmSolution = null;
        state.confirmDelete = false;
        state.confirmRevert = false;
        state.pickTheme = null;
        state.pickSolver = null;
        state.pickGrave = null;
        render();
      });
    });
  }

  // ── загрузка ────────────────────────────────────────────

  function loadFromFiles() {
    function get(path) {
      return fetch("data/" + path + "?t=" + Date.now(), { cache: "no-store" })
        .then(function (r) {
          if (!r.ok) {
            // код нужен, чтобы отличить «файла нет» от «не прочиталось»
            var e = new Error(path + ": " + r.status);
            e.status = r.status;
            throw e;
          }
          return r.json();
        });
    }
    /* Гробарий и список дней читаем мягко: редактор должен открыться и тогда,
       когда что-то из этого пропало. Но прочиталось оно или нет — запоминаем:
       непрочитанное нельзя переписывать, иначе пустой экран уехал бы в
       репозиторий поверх настоящих данных. */
    var gravesOk = true;
    var soft = get("graves.json").catch(function () {
      gravesOk = false;
      return { problems: [], solved: {} };
    });
    var daysOk = true;
    var days = get("series/manifest.json").catch(function () {
      daysOk = false;
      return null;
    });
    return Promise.all([
      get("config.json"), get("types.json"), get("students.json"), days, soft
    ]).then(function (res) {
      /* Ученики стоят по алфавиту: в кондуите ищут человека, а не место.
         Сравнивается полное имя, поэтому однофамильцы идут по именам. */
      res[2].sort(function (a, b) { return a.name.localeCompare(b.name, "ru"); });

      var files = res[3] && Array.isArray(res[3].series) ? res[3].series : [];
      if (res[3] && !Array.isArray(res[3].series)) daysOk = false;

      // пропавший файл дня не должен мешать открыть редактор
      return Promise.all(files.map(function (f) {
        return get("series/" + f).catch(function () { return null; });
      }))
        .then(function (all) {
          var series = all.filter(Boolean);
          // лента идёт по датам: номер теперь принадлежит серии, а не дню
          series.sort(function (a, b) {
            return String(a.date).localeCompare(String(b.date)) || a.n - b.n;
          });
          return {
            config: res[0], types: res[1], students: res[2],
            series: series, daysOk: daysOk, gravesOk: gravesOk,
            graves: {
              problems: res[4].problems || [],
              solutions: res[4].solutions,
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
      // рабочую копию дня, догнавшую сайт, держать больше незачем
      Object.keys(state.days).forEach(function (k) {
        var day = state.days[k];
        if (day === state.series) return;
        var s = dayBySlot(day.n);
        if (s && JSON.stringify(dayPayload(day)) === JSON.stringify(dayPayload(s))) {
          delete state.days[k];
          delete SAVED.days[k];
        }
      });
      /* Правку держим в памяти, пока сайт не догонит: иначе сразу после
         сохранения экран показал бы старые данные, будто правка потерялась. */
      if (state.typesEdit &&
          JSON.stringify(state.typesEdit) === JSON.stringify(DATA.types)) {
        state.typesEdit = null;
        SAVED.types = null;
      }
      if (state.graves &&
          JSON.stringify(gravesPayload(state.graves)) ===
          JSON.stringify(gravesPayload(DATA.graves))) {
        state.graves = null;
        SAVED.graves = null;
      }
      if (state.sig !== null && state.sig ===
          !!(DATA.config.signature && DATA.config.signature.on)) {
        state.sig = null;
        SAVED.sig = null;
      }
      if (state.wn !== null && state.wn === configN()) {
        state.wn = null;
        SAVED.wn = null;
      }
      render();
    }).catch(function () { render(); });
  }

  /* Как на сайте: отклик на касание — классом и анимацией, а не :active,
     который на телефоне для быстрого тапа не успевает примениться. Клетки
     кондуита исключены — у них своя анимация плюса. */
  var TAPPABLE = "button:not(.mark), .chip, a.ghost-btn";

  document.addEventListener("DOMContentLoaded", function () {
    document.title = "Статистика — редактор";
    document.addEventListener("pointerdown", function (e) {
      var node = e.target.closest && e.target.closest(TAPPABLE);
      if (!node || node.disabled) return;
      node.classList.remove("tap");
      void node.offsetWidth;
      node.classList.add("tap");
    }, { passive: true });

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
