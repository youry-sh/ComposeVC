"""
local-coding-agent — MCP-сервер: кодинг-агент через чат Notion.

Даёт Notion Agent доступ к файлам и shell на этом компьютере.
Работает на macOS, Linux и Windows (один и тот же код).

Транспорт: Streamable HTTP на /mcp (рекомендован Notion для новых клиентов).
Auth: Bearer token (заголовок Authorization, X-API-Key или ?token= в query).

Запуск:
    Mac/Linux:  ./run.sh
    Windows:    run.bat
    Вручную:    python server.py  (нужен MCP_TOKEN в .env или config.yaml)
"""

from __future__ import annotations

import asyncio
import json
import os
import platform
import re
import secrets
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import yaml
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, PlainTextResponse, Response
from starlette.routing import Route

BASE_DIR = Path(__file__).parent
CONFIG_PATH = BASE_DIR / "config.yaml"

IS_WINDOWS = os.name == "nt" or platform.system().lower() == "windows"


def _default_shell_executable() -> str | None:
    """Какой shell использовать для команд. На Windows — системный по умолчанию."""
    if IS_WINDOWS:
        return None
    for candidate in ("/bin/zsh", "/bin/bash"):
        if Path(candidate).is_file():
            return candidate
    return None


SHELL_EXE = _default_shell_executable()


def _load_dotenv() -> None:
    """Минимальный .env-лоадер без зависимостей: KEY=VALUE, кавычки и # комментарии."""
    env_path = BASE_DIR / ".env"
    if not env_path.is_file():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        if key and key not in os.environ:
            os.environ[key] = val


def load_config() -> dict:
    _load_dotenv()
    cfg: dict = {}
    if CONFIG_PATH.exists():
        cfg = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8")) or {}
    # env имеет приоритет над yaml
    if os.getenv("MCP_TOKEN"):
        cfg["token"] = os.environ["MCP_TOKEN"]
    if os.getenv("MCP_PORT"):
        cfg["port"] = int(os.environ["MCP_PORT"])
    if os.getenv("ALLOWED_DIRS"):
        cfg["allowed_dirs"] = os.environ["ALLOWED_DIRS"].split(os.pathsep)
    cfg.setdefault("host", "127.0.0.1")
    cfg.setdefault("port", 8000)
    # Режим Claude Code / OpenCode: allowed_dirs ["*"] = полный доступ
    # от имени пользователя, без песочницы. Защита — approval + audit.log.
    # Чтобы ограничить папками — впиши их список вместо "*".
    cfg.setdefault("allowed_dirs", ["*"])
    cfg.setdefault("allow_all_paths", False)
    cfg.setdefault("max_file_bytes", 1_048_576)
    cfg.setdefault("max_output_chars", 20_000)
    cfg.setdefault("default_shell_timeout", 30)
    cfg.setdefault("max_shell_timeout", 120)
    cfg.setdefault("deny_patterns", [])
    cfg.setdefault("deny_paths", [])
    cfg.setdefault("audit_log", "./audit.log")
    return cfg


CONFIG = load_config()
TOKEN: str = str(CONFIG.get("token") or "")
if not TOKEN or TOKEN.startswith("CHANGE_ME"):
    print(
        "WARNING: MCP_TOKEN не задан! Создай файл .env по образцу .env.example "
        "или впиши token в config.yaml.\n"
        'Сгенерировать: python -c "import secrets; print(secrets.token_urlsafe(32))"'
    )

ALLOWED_DIRS = [Path(os.path.expanduser(p)).resolve()
                for p in CONFIG["allowed_dirs"] if p != "*"]
FULL_ACCESS = "*" in CONFIG["allowed_dirs"] or bool(CONFIG.get("allow_all_paths"))
if FULL_ACCESS:
    print("MODE: full access (как Claude Code/OpenCode) — песочница выключена, "
          "защита: подтверждение новых папок + audit.log")
DENY_RES = [re.compile(p, re.IGNORECASE) for p in CONFIG.get("deny_patterns", [])]
DENY_PATH_PARTS = list(CONFIG.get("deny_paths", []))
AUDIT_LOG = (BASE_DIR / str(CONFIG["audit_log"])).resolve() \
    if not str(CONFIG["audit_log"]).startswith("/") and not (
        IS_WINDOWS and re.match(r"^[A-Za-z]:[\\/]", str(CONFIG["audit_log"]))) \
    else Path(str(CONFIG["audit_log"]))

mcp = FastMCP(
    name="local-coding-agent",
    instructions=(
        "Coding agent on the owner's computer with full filesystem access (like Claude Code). "
        "Always list a directory before editing. Prefer small fs_edit diffs over full rewrites. "
        "Prefer search (fs_grep) and glob (fs_glob) before reading whole trees. "
        "Keep shell timeouts short, use shell_run_async for long builds/tests. "
        "FIRST-TOUCH RULE: if any tool returns need_approval with a zone, STOP and ask "
        "the user in chat whether to grant access to that folder. Only after an explicit "
        "yes call approve_zone(zone, confirm=true), then retry the original call."
    ),
    host=str(CONFIG["host"]),
    port=int(CONFIG["port"]),
    streamable_http_path="/mcp",
    stateless_http=True,   # устойчивее через туннель: нет sticky-сессий
    json_response=True,    # plain JSON вместо SSE-стрима — лучше проходит через туннели
    # Туннели подменяют Host — родная DNS-rebinding защита SDK такой хост режет.
    # Отключаем её: авторизация у нас по Bearer-токену в middleware.
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)


# ---------- security helpers ----------

class SecurityError(ValueError):
    pass


class NeedApprovalError(SecurityError):
    """Доступ к новой зоне: агент должен спросить пользователя, вызвать
    approve_zone(confirm=true) и повторить исходный вызов."""
    def __init__(self, zone: str):
        super().__init__(f"новая папка: {zone}")
        self.zone = zone


def _deny(e: Exception) -> dict:
    if isinstance(e, NeedApprovalError):
        return {"ok": False, "need_approval": True, "zone": e.zone,
                "error": (f"НОВАЯ ПАПКА {e.zone}: остановись и спроси пользователя "
                          f"в чате, дать ли доступ. Если да — вызови "
                          f"approve_zone(zone=\"{e.zone}\", confirm=true) "
                          f"и повтори исходный вызов.")}
    return {"ok": False, "error": str(e)}


# ---------- зоны доступа ("спрашивать только про новую папку") ----------

ZONES_FILE = BASE_DIR / "approved_zones.json"


def zone_of(resolved: Path) -> str:
    """Зона = папка верхнего уровня.

    macOS/Linux: /Users/<имя>/<папка> или /<раздел> (например /etc, /tmp).
    Windows:     C:\\Users\\<имя>\\<папка> или C:\\<папка> (например C:\\Windows).
    """
    parts = resolved.parts
    if len(parts) >= 4 and parts[1].lower() == "users":
        return str(Path(*parts[:4]))
    if len(parts) >= 2:
        return str(Path(*parts[:2]))
    return str(resolved)


def _seed_zones() -> set[str]:
    """Стартовая знакомая папка — только Рабочий стол.
    Всё остальное агент спросит один раз при первом касании."""
    return {str(Path.home() / "Desktop")}


def _load_zones() -> set[str]:
    if ZONES_FILE.is_file():
        try:
            return set(json.loads(ZONES_FILE.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError):
            pass
    zones = _seed_zones()
    _save_zones(zones)
    return zones


def _save_zones(zones: set[str]) -> None:
    try:
        ZONES_FILE.write_text(json.dumps(sorted(zones), ensure_ascii=False, indent=1),
                              encoding="utf-8")
    except OSError:
        pass


APPROVED_ZONES = _load_zones()


def require_zone(resolved: Path) -> None:
    zone = zone_of(resolved)
    if zone not in APPROVED_ZONES:
        raise NeedApprovalError(zone)


_POSIX_PATH_RX = re.compile(
    r"(?<![\w.])(/(?:Users|private|etc|tmp|var|opt|usr|Applications|Library|home|mnt|data)[^\s'\"`$|;&<>]*)")
_WIN_PATH_RX = re.compile(r"(?<![\w])([A-Za-z]:[\\/][^\s'\"`$|;&<>]*)")


def require_command_zones(command: str) -> None:
    """Ловит абсолютные пути прямо внутри shell-команды (cat /etc/x, dir C:\\Docs)."""
    candidates: list[str] = [m.group(1) for m in _POSIX_PATH_RX.finditer(command)]
    candidates += [m.group(1) for m in _WIN_PATH_RX.finditer(command)]
    for raw in candidates:
        raw = raw.rstrip(".,:)")
        try:
            require_zone(Path(os.path.expanduser(raw)).resolve())
        except OSError:
            continue


def _is_inside_allowed(resolved: Path) -> bool:
    if FULL_ACCESS:
        return True
    return any(
        resolved == root or root in resolved.parents
        for root in ALLOWED_DIRS
    )


def _has_denied_part(resolved: Path) -> str | None:
    if FULL_ACCESS:
        return None
    parts = {p.lower() for p in resolved.parts}
    for denied in DENY_PATH_PARTS:
        if denied.lower() in parts:
            return denied
    return None


def _is_protected_root(target: Path) -> bool:
    """Корни, которые удалять нельзя никогда: корень диска, домашняя папка, папка сервера."""
    try:
        if target.parent == target:  # "/" или "C:\\"
            return True
        if target == Path.home().resolve():
            return True
        if target == BASE_DIR.resolve():
            return True
    except OSError:
        pass
    return False


def resolve_path(user_path: str, cwd: str | None = None) -> Path:
    """Резолвит путь. В FULL_ACCESS режиме jail выключен (как Claude Code),
    но новая папка верхнего уровня требует подтверждения (зоны)."""
    if not user_path or not user_path.strip():
        raise SecurityError("пустой путь запрещён")
    p = Path(os.path.expanduser(user_path.strip()))
    if not p.is_absolute():
        if cwd:
            base = Path(os.path.expanduser(cwd)).resolve()
        elif ALLOWED_DIRS:
            base = ALLOWED_DIRS[0]
        else:
            base = Path.home().resolve()
        p = base / p
    try:
        resolved = p.resolve()
    except Exception:
        resolved = p.absolute()
    denied = _has_denied_part(resolved)
    if denied:
        raise SecurityError(f"путь содержит запрещённый компонент '{denied}': {resolved}")
    if not _is_inside_allowed(resolved):
        raise SecurityError(
            f"путь вне песочницы: {resolved}. Разрешено: {', '.join(map(str, ALLOWED_DIRS))}"
        )
    require_zone(resolved)  # новая папка верхнего уровня → NeedApprovalError
    return resolved


def check_shell_allowed(command: str) -> None:
    if FULL_ACCESS:
        return  # как в Claude Code: запретов нет, защита — подтверждение зон
    for rx in DENY_RES:
        if rx.search(command):
            raise SecurityError(f"команда запрещена правилом '{rx.pattern}': {command[:120]}")


def truncate(text: str, limit: int) -> tuple[str, bool]:
    if len(text) > limit:
        return text[:limit] + f"\n... [truncated {len(text) - limit} chars]", True
    return text, False


def audit(tool: str, args: dict, ok: bool, note: str = "") -> None:
    try:
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "tool": tool,
            "args": {k: (str(v)[:500]) for k, v in args.items()},
            "ok": ok,
            "note": str(note)[:500],
        }
        with open(AUDIT_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


# ---------- background jobs for long commands ----------

JOBS: dict[str, dict] = {}


async def _run_job(job_id: str, command: str, cwd: str, timeout: int) -> None:
    job = JOBS[job_id]
    try:
        kwargs: dict = dict(
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        if SHELL_EXE:
            kwargs["executable"] = SHELL_EXE
        proc = await asyncio.create_subprocess_shell(command, **kwargs)  # type: ignore[arg-type]
        job["pid"] = proc.pid
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            job["output"] = out.decode("utf-8", errors="replace")
            job["exit_code"] = proc.returncode
            job["status"] = "done"
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            out, _ = await proc.communicate()
            job["output"] = (out or b"").decode("utf-8", errors="replace")
            job["exit_code"] = 124
            job["status"] = "timeout"
    except Exception as e:  # noqa: BLE001
        job["status"] = "error"
        job["output"] = f"{type(e).__name__}: {e}"
        job["exit_code"] = 1
    job["finished_at"] = time.time()


# ---------- MCP tools ----------

@mcp.tool()
def system_info() -> dict:
    """Информация о хосте. Вызови первым, чтобы понять где ты."""
    info = {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "cwd_server": os.getcwd(),
        "mode": "full_access (как Claude Code)" if FULL_ACCESS else "sandbox",
        "allowed_dirs": ["* (весь диск от имени пользователя)"] if FULL_ACCESS
                        else [str(p) for p in ALLOWED_DIRS],
        "time_utc": datetime.now(timezone.utc).isoformat(),
    }
    audit("system_info", {}, True)
    return info


@mcp.tool()
def fs_list(path: str = ".", recursive: bool = False, max_entries: int = 100) -> dict:
    """Листинг директории. Новую папку верхнего уровня сначала надо подтвердить (зоны)."""
    try:
        root = resolve_path(path)
    except SecurityError as e:
        audit("fs_list", {"path": path}, False, str(e))
        return _deny(e)
    if not root.exists():
        audit("fs_list", {"path": path}, False, "not found")
        return {"ok": False, "error": f"не существует: {root}"}
    if root.is_file():
        st = root.stat()
        return {"ok": True, "path": str(root), "type": "file", "size": st.st_size}
    entries: list[dict] = []
    if recursive:
        for dirpath, dirnames, filenames in os.walk(root):
            # не лезем в мусор и venv
            dirnames[:] = [d for d in dirnames if d not in {".git", "__pycache__", "node_modules", ".venv", "venv"}][:30]
            for name in dirnames + filenames:
                full = Path(dirpath) / name
                try:
                    rel = str(full.relative_to(root))
                    entries.append({
                        "path": rel,
                        "type": "dir" if (full.is_dir()) else "file",
                        "size": full.stat().st_size if full.is_file() else 0,
                    })
                except OSError:
                    continue
                if len(entries) >= max_entries:
                    break
            if len(entries) >= max_entries:
                break
    else:
        try:
            for child in sorted(root.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
                entries.append({
                    "name": child.name,
                    "type": "dir" if child.is_dir() else "file",
                    "size": child.stat().st_size if child.is_file() else 0,
                })
                if len(entries) >= max_entries:
                    break
        except OSError as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    audit("fs_list", {"path": path}, True, f"{len(entries)} entries")
    return {"ok": True, "path": str(root), "entries": entries, "truncated": len(entries) >= max_entries}


@mcp.tool()
def fs_read(path: str, offset: int = 0, limit: int = 100) -> dict:
    """Прочитать текстовый файл построчно (1-indexed offset). Бинарники и файлы > лимита отклоняются."""
    try:
        target = resolve_path(path)
    except SecurityError as e:
        audit("fs_read", {"path": path}, False, str(e))
        return _deny(e)
    if not target.is_file():
        return {"ok": False, "error": f"не файл: {target}"}
    size = target.stat().st_size
    if size > int(CONFIG["max_file_bytes"]):
        return {"ok": False, "error": f"файл слишком большой ({size} байт), лимит {CONFIG['max_file_bytes']}"}
    try:
        text = target.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return {"ok": False, "error": "файл не текстовый (UTF-8 не декодируется)"}
    except OSError as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    lines = text.splitlines()
    total = len(lines)
    start = max(offset - 1, 0) if offset > 0 else 0
    chunk = lines[start:start + limit]
    numbered = [f"{i + 1 + start}: {line}" for i, line in enumerate(chunk)]
    audit("fs_read", {"path": path}, True, f"lines {start+1}-{start+len(chunk)}/{total}")
    return {"ok": True, "path": str(target), "total_lines": total,
            "offset": offset, "content": "\n".join(numbered)}


@mcp.tool()
def fs_write(path: str, content: str) -> dict:
    """Создать или ПЕРЕЗАПИСАТЬ файл целиком. Родительские папки создаются."""
    try:
        target = resolve_path(path)
    except SecurityError as e:
        audit("fs_write", {"path": path}, False, str(e))
        return _deny(e)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    except OSError as e:
        audit("fs_write", {"path": path}, False, str(e))
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    audit("fs_write", {"path": path}, True, f"{len(content)} chars")
    return {"ok": True, "path": str(target), "bytes": len(content.encode())}


@mcp.tool()
def fs_edit(path: str, old_string: str, new_string: str, replace_all: bool = False) -> dict:
    """Точечная правка файла: заменить old_string на new_string. Ошибка если не найдено или найдено несколько (без replace_all)."""
    try:
        target = resolve_path(path)
    except SecurityError as e:
        audit("fs_edit", {"path": path}, False, str(e))
        return _deny(e)
    if not target.is_file():
        return {"ok": False, "error": f"не файл: {target}"}
    try:
        text = target.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError) as e:
        return {"ok": False, "error": f"не могу прочитать: {e}"}
    count = text.count(old_string)
    if count == 0:
        return {"ok": False, "error": "old_string не найден в файле"}
    if count > 1 and not replace_all:
        return {"ok": False, "error": f"найдено совпадений: {count}. Уточни контекст или поставь replace_all=true"}
    new_text = text.replace(old_string, new_string) if replace_all else text.replace(old_string, new_string, 1)
    target.write_text(new_text, encoding="utf-8")
    audit("fs_edit", {"path": path}, True, f"replaced {count if replace_all else 1}")
    return {"ok": True, "path": str(target), "replacements": count if replace_all else 1}


@mcp.tool()
def fs_glob(pattern: str, root: str = ".", max_entries: int = 100) -> dict:
    """Найти файлы по glob-паттерну (как Glob в Claude Code): '**/*.py', 'src/**/*.ts'."""
    try:
        base = resolve_path(root)
    except SecurityError as e:
        audit("fs_glob", {"pattern": pattern}, False, str(e))
        return _deny(e)
    if not base.is_dir():
        return {"ok": False, "error": f"root не директория: {base}"}
    if pattern.startswith("/") or ".." in pattern.split("/"):
        return {"ok": False, "error": "абсолютные паттерны и '..' запрещены"}
    if re.match(r"^[A-Za-z]:", pattern):
        return {"ok": False, "error": "абсолютные паттерны запрещены (и C:\\ тоже)"}
    try:
        matches = sorted(base.glob(pattern), key=lambda p: str(p))
    except ValueError as e:
        return {"ok": False, "error": f"плохой паттерн: {e}"}
    out: list[str] = []
    for m in matches:
        try:
            resolved = m.resolve()
        except OSError:
            continue
        if not _is_inside_allowed(resolved) or _has_denied_part(resolved):
            continue  # симлинк наружу или запрещённая зона — молча пропускаем
        try:
            require_zone(resolved)
        except NeedApprovalError:
            continue  # неподтверждённая зона — молча пропускаем
        out.append(str(resolved.relative_to(base)))
        if len(out) >= max_entries:
            break
    audit("fs_glob", {"pattern": pattern}, True, f"{len(out)} matches")
    return {"ok": True, "root": str(base), "matches": out,
            "truncated": len(out) >= max_entries}


@mcp.tool()
def fs_grep(pattern: str, root: str = ".", include: str = "*", max_matches: int = 50) -> dict:
    """Поиск по содержимому файлов (как Grep в Claude Code). pattern — regex. Мусор (.git, node_modules, .venv) пропускается."""
    try:
        base = resolve_path(root)
    except SecurityError as e:
        audit("fs_grep", {"pattern": pattern}, False, str(e))
        return _deny(e)
    if not base.is_dir():
        return {"ok": False, "error": f"root не директория: {base}"}
    try:
        rx = re.compile(pattern)
    except re.error as e:
        return {"ok": False, "error": f"плохой regex: {e}"}
    skip_dirs = {".git", "__pycache__", "node_modules", ".venv", "venv", ".mypy_cache", ".pytest_cache"}
    hits: list[dict] = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in skip_dirs]
        for name in filenames:
            if not Path(name).match(include):
                continue
            full = Path(dirpath) / name
            try:
                if full.stat().st_size > 512 * 1024:
                    continue
                resolved = full.resolve()
            except OSError:
                continue
            if not _is_inside_allowed(resolved) or _has_denied_part(resolved):
                continue
            try:
                require_zone(resolved)
            except NeedApprovalError:
                continue
            try:
                with open(resolved, encoding="utf-8", errors="strict") as f:
                    for i, line in enumerate(f, 1):
                        if rx.search(line):
                            rel = str(resolved.relative_to(base))
                            hits.append({"file": rel, "line": i,
                                         "text": line.strip()[:300]})
                            if len(hits) >= max_matches:
                                break
            except (UnicodeDecodeError, OSError):
                continue  # бинарник — пропускаем
            if len(hits) >= max_matches:
                break
        if len(hits) >= max_matches:
            break
    audit("fs_grep", {"pattern": pattern[:100]}, True, f"{len(hits)} hits")
    return {"ok": True, "root": str(base), "matches": hits,
            "truncated": len(hits) >= max_matches}


@mcp.tool()
def fs_mkdir(path: str) -> dict:
    """Создать директорию (включая родителей)."""
    try:
        target = resolve_path(path)
    except SecurityError as e:
        audit("fs_mkdir", {"path": path}, False, str(e))
        return _deny(e)
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    audit("fs_mkdir", {"path": path}, True)
    return {"ok": True, "path": str(target)}


@mcp.tool()
def fs_delete(path: str) -> dict:
    """Удалить файл или ПУСТУЮ директорию. Рекурсивного удаления нет — защита от rm -rf."""
    try:
        target = resolve_path(path)
    except SecurityError as e:
        audit("fs_delete", {"path": path}, False, str(e))
        return _deny(e)
    if target in ALLOWED_DIRS or _is_protected_root(target):
        return {"ok": False, "error": "этот путь удалять нельзя (корень/дом/папка сервера)"}
    try:
        if target.is_dir():
            target.rmdir()  # упадёт если не пустая — так и задумано
        elif target.exists():
            target.unlink()
        else:
            return {"ok": False, "error": f"не существует: {target}"}
    except OSError as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e} (директория должна быть пустой)"}
    audit("fs_delete", {"path": path}, True)
    return {"ok": True, "path": str(target)}


@mcp.tool()
def shell_run(command: str, cwd: str = ".", timeout: int = 30) -> dict:
    """Выполнить shell-команду синхронно. Долгие — через shell_run_async."""
    timeout = max(1, min(int(timeout), int(CONFIG["max_shell_timeout"])))
    try:
        workdir = resolve_path(cwd)
        check_shell_allowed(command)
        require_command_zones(command)
    except SecurityError as e:
        audit("shell_run", {"command": command[:200], "cwd": cwd}, False, str(e))
        return _deny(e)
    if not workdir.is_dir():
        return {"ok": False, "error": f"cwd не директория: {workdir}"}
    try:
        run_kwargs: dict = dict(
            shell=True, cwd=str(workdir),
            capture_output=True, text=True, timeout=timeout,
        )
        if SHELL_EXE:
            run_kwargs["executable"] = SHELL_EXE
        proc = subprocess.run(command, **run_kwargs)  # type: ignore[arg-type]
        out = (proc.stdout or "") + (proc.stderr or "")
        _, was_truncated = truncate(out, int(CONFIG["max_output_chars"]))
        audit("shell_run", {"command": command[:200], "cwd": str(workdir)}, True, f"exit={proc.returncode}")
        return {"ok": True, "exit_code": proc.returncode,
                "stdout": proc.stdout[-int(CONFIG["max_output_chars"]):] if proc.stdout else "",
                "stderr": proc.stderr[-int(CONFIG["max_output_chars"]):] if proc.stderr else "",
                "combined_truncated": was_truncated}
    except subprocess.TimeoutExpired as e:
        out = ((e.stdout or b"") + (e.stderr or b"")).decode("utf-8", errors="replace") \
            if isinstance(e.stdout, bytes) else str(e.stdout or "") + str(e.stderr or "")
        out, _ = truncate(out, int(CONFIG["max_output_chars"]))
        audit("shell_run", {"command": command[:200]}, False, "timeout")
        return {"ok": False, "error": f"timeout {timeout}s", "output": out}
    except OSError as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@mcp.tool()
def shell_run_async(command: str, cwd: str = ".", timeout: int = 120) -> dict:
    """Запустить долгую команду в фоне (npm install, pytest, build). Результат забрать через shell_poll."""
    timeout = max(1, min(int(timeout), 600))
    try:
        workdir = resolve_path(cwd)
        check_shell_allowed(command)
        require_command_zones(command)
    except SecurityError as e:
        audit("shell_run_async", {"command": command[:200]}, False, str(e))
        return _deny(e)
    job_id = uuid.uuid4().hex[:12]
    JOBS[job_id] = {"status": "running", "output": "", "exit_code": None,
                    "pid": None, "started_at": time.time(), "command": command[:300]}
    asyncio.get_event_loop().create_task(_run_job(job_id, command, str(workdir), timeout))
    audit("shell_run_async", {"command": command[:200]}, True, f"job={job_id}")
    return {"ok": True, "job_id": job_id,
            "hint": "забери результат через shell_poll(job_id)"}


@mcp.tool()
def shell_poll(job_id: str, tail_chars: int = 8000) -> dict:
    """Проверить статус фоновой команды, запущенной через shell_run_async."""
    job = JOBS.get(job_id)
    if not job:
        return {"ok": False, "error": f"job не найден: {job_id}"}
    out = job.get("output", "") or ""
    return {"ok": True, "job_id": job_id, "status": job["status"],
            "exit_code": job.get("exit_code"), "output_tail": out[-tail_chars:]}


@mcp.tool()
def approve_zone(zone: str, confirm: bool = False) -> dict:
    """Подтвердить доступ к новой папке (зоне). Вызывай ТОЛЬКО после явного
    'да' пользователя в чате, с confirm=true. После этого повтори исходный вызов."""
    zone = zone.strip()
    if zone in APPROVED_ZONES:
        return {"ok": True, "zone": zone, "already": True}
    if not confirm:
        return {"ok": False, "error": f"зона {zone} не подтверждена: нужен approve_zone с confirm=true после согласия пользователя"}
    APPROVED_ZONES.add(zone)
    _save_zones(APPROVED_ZONES)
    audit("approve_zone", {"zone": zone}, True, "approved by user")
    return {"ok": True, "zone": zone,
            "hint": "доступ открыт и запомнен, повтори исходный вызов"}


@mcp.tool()
def list_zones() -> dict:
    """Показать папки, к которым доступ уже подтверждён (вопросов по ним не будет)."""
    return {"ok": True, "zones": sorted(APPROVED_ZONES)}


@mcp.tool()
def revoke_zone(zone: str, confirm: bool = False) -> dict:
    """Отозвать доступ к папке: следующие обращения к ней снова спросят пользователя."""
    zone = zone.strip()
    if zone not in APPROVED_ZONES:
        return {"ok": True, "zone": zone, "already": "не была подтверждена"}
    if not confirm:
        return {"ok": False,
                "error": f"подтверди отзыв: revoke_zone(zone=\"{zone}\", confirm=true)"}
    APPROVED_ZONES.discard(zone)
    _save_zones(APPROVED_ZONES)
    audit("revoke_zone", {"zone": zone}, True, "revoked")
    return {"ok": True, "zone": zone, "hint": "доступ отозван, дальше будет спрашивать"}


# ---------- HTTP: auth + health ----------

class BearerAuthMiddleware(BaseHTTPMiddleware):
    """Bearer-авторизация + совместимость с разными MCP-клиентами.

    Практика показала три вещи, которые ломают «Add Custom MCP» в веб-клиентах:
      1) 401 на /.well-known/oauth-protected-resource — клиент считает, что сервер
         требует OAuth, и валит сохранение коннекта (у WonkaAI это 500);
      2) HEAD /mcp без токена — клиент принимает 401 за «сервер недоступен»;
      3) GET /mcp — попытка открыть SSE-стрим. Мы его не используем (stateless +
         json_response), но соединение висит открытым до таймаута, и бэкенд,
         который ждёт завершения, отдаёт 500. По спеке MCP правильный ответ — 405.
    """

    async def dispatch(self, request, call_next):
        path = request.url.path
        method = request.method

        # 1) OAuth-discovery: отвечаем 200 и говорим, что авторизация — Bearer-заголовок.
        if path.startswith("/.well-known/"):
            base = str(request.base_url).rstrip("/")
            return JSONResponse({
                "resource": f"{base}/mcp",
                "resource_name": "local-coding-agent",
                "bearer_methods_supported": ["header"],
                "authorization_servers": [],
            })

        # 2) Лёгкая проверка доступности (без данных) — без токена.
        if path in ("/mcp", "/") and method in ("HEAD", "OPTIONS"):
            return Response(status_code=200, headers={"Allow": "POST, HEAD, OPTIONS"})

        # 3) SSE-стрим не поддерживаем — 405 вместо бесконечно открытого соединения.
        if path == "/mcp" and method == "GET":
            return JSONResponse(
                {"error": "SSE stream is not supported, use POST /mcp"},
                status_code=405,
                headers={"Allow": "POST"},
            )

        if path in ("/health", "/"):
            return await call_next(request)
        if not TOKEN:
            return JSONResponse({"error": "server token not configured"}, status_code=500)
        auth = request.headers.get("authorization", "")
        api_key = request.headers.get("x-api-key", "")
        q_token = request.query_params.get("token", "")
        provided = ""
        if auth.lower().startswith("bearer "):
            provided = auth[7:].strip()
        elif api_key:
            provided = api_key.strip()
        elif q_token:
            provided = q_token.strip()
        elif auth:
            provided = auth.strip()      # клиент прислал голый токен без "Bearer"
        if not provided or not secrets.compare_digest(provided, TOKEN):
            return JSONResponse(
                {"error": "unauthorized: передай заголовок Authorization: Bearer <TOKEN>"},
                status_code=401,
                headers={"WWW-Authenticate": 'Bearer realm="local-coding-agent"'},
            )
        return await call_next(request)


async def health(request):
    return JSONResponse({
        "ok": True,
        "service": "local-coding-agent",
        "time_utc": datetime.now(timezone.utc).isoformat(),
        "allowed_dirs": (["* (весь диск)"] if FULL_ACCESS
                         else [str(p) for p in ALLOWED_DIRS]),
        "tools": ["system_info", "fs_list", "fs_read", "fs_write", "fs_edit",
                  "fs_glob", "fs_grep", "fs_mkdir", "fs_delete",
                  "approve_zone", "revoke_zone", "list_zones",
                  "shell_run", "shell_run_async", "shell_poll"],
    })


async def index(request):
    return PlainTextResponse(
        "local-coding-agent MCP\n"
        "Streamable HTTP: POST /mcp  (Authorization: Bearer <TOKEN>)\n"
        "Health: GET /health\n"
    )


def build_app():
    app = mcp.streamable_http_app()
    app.routes.append(Route("/health", health, methods=["GET"]))
    app.routes.append(Route("/", index, methods=["GET"]))
    app.add_middleware(BearerAuthMiddleware)
    return app


def main() -> None:
    import uvicorn
    app = build_app()
    host, port = str(CONFIG["host"]), int(CONFIG["port"])
    url = f"http://{host}:{port}/mcp"
    print(f"local-coding-agent MCP on {url}")
    if FULL_ACCESS:
        print("allowed: ВЕСЬ ДИСК (full access, как Claude Code/OpenCode)")
    else:
        print(f"allowed_dirs: {', '.join(map(str, ALLOWED_DIRS))}")
    print(f"audit log: {AUDIT_LOG}")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
