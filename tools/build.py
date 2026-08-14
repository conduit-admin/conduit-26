"""Сборка: версия статики и офлайн-копия.

    python tools/build.py

Сам сайт собирать не нужно: GitHub Pages раздаёт корень репозитория как есть,
index.html читает файлы из data/ прямо в браузере. Поэтому правка данных с
телефона меняет сайт без всякой пересборки.

Скрипт делает две вещи:

1. Проставляет версию в ссылки на стили и скрипты: assets/style.css?v=…
   Без этого браузер телефона может неделю показывать старый кэш, и правки
   выглядят «не применившимися». Версия — время сборки.

2. Собирает offline.html: страница, стили, скрипт и все данные в одном файле.
   Он открывается без интернета, но это снимок на момент сборки — в шапке
   проставляется дата, чтобы вчерашнюю копию нельзя было спутать с сегодняшней.
"""

import json
import re
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
PAGES = ["index.html", "edit.html"]
OUT = ROOT / "offline.html"

ASSET_RE = re.compile(r'(?P<attr>href|src)="(?P<path>assets/[\w.-]+)(?:\?v=[^"]*)?"')


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


BUILD_META_RE = re.compile(r'<meta name="build" content="[^"]*">')


def stamp_pages(version: str) -> None:
    """Версия в ссылках на стили и в мета-теге.

    Мета нужна, чтобы страница могла заметить, что сама устарела: GitHub Pages
    отдаёт HTML из кэша ещё минут десять после выкладки, и тогда свежая версия
    стилей просто не запрашивается. Скрипт сверяет мету с версией из config.json
    (его всегда тянут мимо кэша) и перезагружается на свежую.
    """
    meta = f'<meta name="build" content="{version}">'
    for name in PAGES:
        path = ROOT / name
        text = path.read_text(encoding="utf-8")
        stamped = ASSET_RE.sub(
            lambda m: f'{m.group("attr")}="{m.group("path")}?v={version}"', text
        )
        if BUILD_META_RE.search(stamped):
            stamped = BUILD_META_RE.sub(meta, stamped)
        else:
            stamped = stamped.replace("</head>", meta + "\n</head>", 1)
        if stamped != text:
            path.write_text(stamped, encoding="utf-8")


def stamp_config(version: str) -> None:
    path = DATA / "config.json"
    config = json.loads(path.read_text(encoding="utf-8"))
    config["build"] = version
    path.write_text(
        json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def load_all() -> dict:
    manifest = read_json(DATA / "series" / "manifest.json")
    graves_path = DATA / "graves.json"
    bundle = {
        "config": read_json(DATA / "config.json"),
        "types": read_json(DATA / "types.json"),
        "students": read_json(DATA / "students.json"),
        "series": [read_json(DATA / "series" / name) for name in manifest["series"]],
        "graves": (
            read_json(graves_path)
            if graves_path.exists()
            else {"problems": [], "solutions": []}
        ),
    }
    bundle["config"]["offline_date"] = date.today().isoformat()
    return bundle


def build_offline(bundle: dict) -> None:
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    css = (ROOT / "assets" / "style.css").read_text(encoding="utf-8")
    js = (ROOT / "assets" / "app.js").read_text(encoding="utf-8")

    payload = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"))
    # чтобы </script> внутри данных не закрыл тег раньше времени
    payload = payload.replace("</", "<\\/")

    html = re.sub(
        r'<link rel="stylesheet" href="assets/style\.css(?:\?v=[^"]*)?">',
        lambda _: "<style>\n" + css + "\n</style>",
        html,
    )
    html = re.sub(
        r'<script src="assets/app\.js(?:\?v=[^"]*)?"></script>',
        lambda _: "<script>window.__CONDUIT__=" + payload + ";</script>\n<script>\n" + js + "\n</script>",
        html,
    )
    assert "assets/" not in html, "остались ссылки на внешние файлы"

    OUT.write_text(html, encoding="utf-8")


def main() -> None:
    version = datetime.now().strftime("%Y%m%d%H%M")
    stamp_pages(version)
    stamp_config(version)

    bundle = load_all()
    build_offline(bundle)

    cells = sum(len(s["problems"]) for s in bundle["series"])
    print(f"версия статики: {version}")
    print(f"offline.html — {OUT.stat().st_size / 1024:.0f} КБ, снимок от {date.today():%d.%m.%Y}")
    graves = bundle["graves"]
    print(f"данные: {len(bundle['students'])} учеников, "
          f"{len(bundle['series'])} серий, {cells} задач, "
          f"{len(graves['problems'])} гробов, "
          f"{len(graves.get('solutions', []))} гроборешений")


if __name__ == "__main__":
    main()
