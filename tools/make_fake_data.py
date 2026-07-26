"""Генератор выдуманных данных для прототипа оформления.

Создаёт data/config.json, data/types.json, data/students.json и data/series/NN.json
с правдоподобной картиной решаемости: у учеников разная сила и разные сильные темы,
у задач разная трудность. Нужен только для прототипа — на реальных данных не запускать.

    python tools/make_fake_data.py
"""

import json
import math
import random
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

SEED = 20260726
STUDENTS_TOTAL = 30
CAMP_START = date(2026, 7, 27)
CAMP_DAYS = 21
DAYS_OFF = {7, 14, 21}  # выходные — в эти дни серии нет

# Темы берутся из data/types.json — это настоящая настройка, а не выдумка.
# Веса — насколько часто тема встречается в серии.
TYPE_WEIGHT = {"algebra": 0.2, "geometry": 0.25, "comb": 0.35, "numbers": 0.2}

NAMES = [
    "Абрамова Соня", "Баранов Кирилл", "Белкина Настя", "Верещагин Гоша",
    "Гаврилов Тимур", "Гордеева Лиза", "Дементьев Матвей", "Ерохина Даша",
    "Жуковский Марк", "Зайцева Полина", "Ильин Серёжа", "Карпова Аня",
    "Ковалёв Дима", "Лебедева Маша", "Лозинский Артём", "Мещерякова Вера",
    "Никитин Егор", "Орлова Ксюша", "Панкратов Лёша", "Прохорова Юля",
    "Романов Ваня", "Савельева Катя", "Сизов Миша", "Тарасова Оля",
    "Устинов Паша", "Фомина Рита", "Хрусталёв Костя", "Чернова Женя",
    "Шаповалов Рома", "Яковлева Нина",
]

assert len(NAMES) == STUDENTS_TOTAL


def slug(name: str, taken: set) -> str:
    table = {
        "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
        "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
        "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
        "ф": "f", "х": "h", "ц": "c", "ч": "ch", "ш": "sh", "щ": "sch",
        "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya", " ": "-",
    }
    out = "".join(table.get(ch, ch) for ch in name.lower())
    base = out
    i = 2
    while out in taken:
        out = f"{base}-{i}"
        i += 1
    taken.add(out)
    return out


def sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def pick_theme(rng: random.Random, types):
    """Случайная тема: сначала раздел, потом — если есть — подраздел."""
    cat = rng.choices(types, weights=[TYPE_WEIGHT.get(t["id"], 0.25) for t in types])[0]
    sub = rng.choice(cat["subs"])["id"] if cat["subs"] else None
    return cat["id"], sub


def make_problems(rng: random.Random, count: int, types):
    """Возвращает список единиц зачёта: задача целиком или её пункты (5а, 5б)."""
    problems = []
    number = 1
    while len(problems) < count:
        cat, sub = pick_theme(rng, types)
        # у части задач есть пункты — они идут одной темой и обычно полегче
        parts = 1
        if rng.random() < 0.28 and len(problems) + 2 <= count:
            parts = 2 if rng.random() < 0.75 else 3
        letters = "абв"
        for k in range(parts):
            pid = f"{number}{letters[k]}" if parts > 1 else str(number)
            difficulty = rng.gauss(0.35, 1.05) - (0.45 if parts > 1 else 0.0)
            problems.append({"id": pid, "type": cat, "sub": sub, "_d": difficulty})
        number += 1
    return problems[:count]


def main() -> None:
    rng = random.Random(SEED)

    types = json.loads((DATA / "types.json").read_text(encoding="utf-8"))
    leaves = []
    for t in types:
        if t["subs"]:
            leaves.extend((t["id"], s["id"]) for s in t["subs"])
        else:
            leaves.append((t["id"], None))

    taken = set()
    students = [{"id": slug(n, taken), "name": n} for n in NAMES]

    ability = {s["id"]: rng.gauss(0.0, 0.95) for s in students}
    # склонность к теме: общая по разделу плюс небольшая поправка на подраздел
    affinity = {}
    for s in students:
        by_cat = {t["id"]: rng.gauss(0.0, 0.6) for t in types}
        affinity[s["id"]] = {
            (c, sub): by_cat[c] + rng.gauss(0.0, 0.35) for c, sub in leaves
        }

    (DATA / "series").mkdir(parents=True, exist_ok=True)

    (DATA / "config.json").write_text(
        json.dumps(
            {
                "title": "Кондуит",
                "subtitle": "Летняя математическая смена · 2026",
                "students_total": STUDENTS_TOTAL,
                "noindex": True,
                "scoring": {
                    "formula": "students_total - solvers",
                    "note": "Вес задачи = число учеников на смене минус число решивших.",
                },
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    (DATA / "students.json").write_text(
        json.dumps(students, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    files = []
    series_no = 0
    for day in range(1, CAMP_DAYS + 1):
        if day in DAYS_OFF:
            continue
        series_no += 1
        when = CAMP_START + timedelta(days=day - 1)
        problems = make_problems(rng, rng.randint(7, 15), types)
        # общая «тяжесть дня» — бывают серии полегче и посложнее
        day_shift = rng.gauss(0.0, 0.35)

        solved = {}
        for s in students:
            got = []
            for p in problems:
                x = (
                    ability[s["id"]]
                    + affinity[s["id"]][(p["type"], p["sub"])]
                    - p["_d"]
                    - day_shift
                    - 0.55
                )
                if rng.random() < sigmoid(x):
                    got.append(p["id"])
            solved[s["id"]] = got

        payload = {
            "n": series_no,
            "day": day,
            "date": when.isoformat(),
            "title": f"Серия {series_no}",
            "problems": [
                {"id": p["id"], "type": p["type"], "sub": p["sub"]} for p in problems
            ],
            "solved": solved,
        }
        name = f"{series_no:02d}.json"
        (DATA / "series" / name).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        files.append(name)

    (DATA / "series" / "manifest.json").write_text(
        json.dumps({"series": files}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    cells = sum(
        len(json.loads((DATA / "series" / f).read_text(encoding="utf-8"))["problems"])
        for f in files
    )
    print(f"готово: {len(students)} учеников, {len(files)} серий, {cells} задач")


if __name__ == "__main__":
    main()
