"""Сборка офлайн-копии.

    python tools/build.py

Сам сайт собирать не нужно: GitHub Pages раздаёт корень репозитория как есть,
index.html читает файлы из data/ прямо в браузере. Поэтому редактору с телефона
достаточно поменять один json — сайт обновится сам.

Этот скрипт делает только офлайн-копию offline.html: страница, стили, скрипт и
все данные, зашитые в один файл. Её можно кинуть в чат или на флешку — она
открывается без интернета. Копия — снимок на момент сборки, поэтому в шапке
проставляется дата: запускать после того, как данные обновились.
"""

import json
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
OUT = ROOT / "offline.html"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def load_all() -> dict:
    manifest = read_json(DATA / "series" / "manifest.json")
    bundle = {
        "config": read_json(DATA / "config.json"),
        "types": read_json(DATA / "types.json"),
        "students": read_json(DATA / "students.json"),
        "series": [read_json(DATA / "series" / name) for name in manifest["series"]],
    }
    bundle["config"]["offline_date"] = date.today().isoformat()
    return bundle


def main() -> None:
    bundle = load_all()

    html = (ROOT / "index.html").read_text(encoding="utf-8")
    css = (ROOT / "assets" / "style.css").read_text(encoding="utf-8")
    js = (ROOT / "assets" / "app.js").read_text(encoding="utf-8")

    payload = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"))
    # чтобы </script> внутри данных не закрыл тег раньше времени
    payload = payload.replace("</", "<\\/")

    html = html.replace(
        '<link rel="stylesheet" href="assets/style.css">',
        "<style>\n" + css + "\n</style>",
    )
    html = html.replace(
        '<script src="assets/app.js"></script>',
        "<script>window.__CONDUIT__=" + payload + ";</script>\n<script>\n" + js + "\n</script>",
    )
    assert "assets/" not in html, "остались ссылки на внешние файлы"

    OUT.write_text(html, encoding="utf-8")

    cells = sum(len(s["problems"]) for s in bundle["series"])
    print(f"offline.html — {OUT.stat().st_size / 1024:.0f} КБ, снимок от {date.today():%d.%m.%Y}")
    print(f"данные: {len(bundle['students'])} учеников, {len(bundle['series'])} серий, {cells} задач")


if __name__ == "__main__":
    main()
