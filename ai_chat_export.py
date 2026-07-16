#!/usr/bin/env python3
"""Export repo-specific AI coding dialogue to a self-contained HTML document.

Supported local stores:
- Claude Code: ~/.claude/projects/**/*.jsonl
- Codex: ~/.codex/{sessions,archived_sessions}/**/*.jsonl
- VS Code Chat: */User/workspaceStorage/*/chatSessions/*.{json,jsonl}

The normal command surface is intentionally small:
    python3 ai_chat_export.py --repo /path/to/git/repo
    python3 ai_chat_export.py --repo /path/to/git/repo --output dialogue.html --open

Nonstandard storage locations can be supplied with path-separated environment
variables: AI_CHAT_CLAUDE_ROOTS, AI_CHAT_CODEX_ROOTS, and
AI_CHAT_VSCODE_USER_ROOTS.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import html
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
import webbrowser
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence

VERSION = "2.0.1"
UTC = dt.timezone.utc


class UserError(RuntimeError):
    """An actionable failure caused by input, local data, or configuration."""


class ExitMessage(RuntimeError):
    """A successful informational exit such as --help or --version."""


@dataclasses.dataclass(frozen=True)
class Roots:
    claude: tuple[Path, ...]
    codex: tuple[Path, ...]
    vscode: tuple[Path, ...]

    def all(self) -> tuple[Path, ...]:
        return self.claude + self.codex + self.vscode


@dataclasses.dataclass(frozen=True)
class Options:
    repo: Path
    output: Path
    open_after: bool


@dataclasses.dataclass
class Message:
    timestamp: dt.datetime
    provider: str
    role: str
    text: str
    session: str
    model: str
    cwd: str
    source: Path
    sequence: int
    native_id: str = ""


@dataclasses.dataclass(frozen=True)
class Exchange:
    timestamp: dt.datetime
    provider: str
    model: str
    session: str
    prompt: str
    reply: str
    source: Path


# TODO: Explain the minimal invocation, the three ordinary flags, and the
# environment variables available only for nonstandard transcript locations.
def help_text() -> str:
    return f"""Usus:
  python3 ai_chat_export.py --repo VIA [--output VIA.html] [--open]

Argumenta:
  --repo VIA      Radix ipsa repositorii Git; hoc argumentum necessarium est.
  --output VIA    Fasciculus HTML novus. Si omittitur: ./NOMEN-ai-dialogus.html
  --open          Fasciculum perfectum in navigatro aperi.
  -h, --help      Hoc auxilium ostende.
  --version       Versionem ostende.

Loca insolita per variabiles ambitus, viis a {os.pathsep!r} separatis:
  AI_CHAT_CLAUDE_ROOTS
  AI_CHAT_CODEX_ROOTS
  AI_CHAT_VSCODE_USER_ROOTS
"""


# TODO: Explain that the command line is intentionally strict: --repo is
# required, options cannot repeat, and unknown options are rejected.
def parse_args(argv: Sequence[str]) -> Options:
    values: dict[str, str] = {}
    flags: set[str] = set()
    i = 0
    while i < len(argv):
        token = argv[i]
        match token:
            case "-h" | "--help":
                raise ExitMessage(help_text())
            case "--version":
                raise ExitMessage(VERSION)
            case "--open":
                if token in flags:
                    raise UserError("Argumentum --open iteratum est.")
                flags.add(token)
                i += 1
            case "--repo" | "--output":
                if token in values:
                    raise UserError(f"Argumentum {token} iteratum est.")
                if i + 1 >= len(argv):
                    raise UserError(f"Argumentum {token} viam postulat.\n\n{help_text()}")
                values[token] = argv[i + 1]
                i += 2
            case _:
                raise UserError(f"Argumentum ignotum: {token}\n\n{help_text()}")

    if "--repo" not in values:
        raise UserError(f"Argumentum --repo necessarium est.\n\n{help_text()}")

    repo = Path(values["--repo"]).expanduser()
    output = Path(values.get("--output", f"{repo.name}-ai-dialogus.html")).expanduser()
    return Options(repo=repo, output=output, open_after="--open" in flags)


# TODO: Explain that the given path must exist, be a directory, be a Git
# repository, and be the repository root rather than one of its subdirectories.
def canonical_repo(path: Path) -> Path:
    candidate = path.resolve()
    if not candidate.exists():
        raise UserError(
            f"Repositorium non inventum: {candidate}\n"
            "Da viam exsistentem ad radicem repositorii Git."
        )
    if not candidate.is_dir():
        raise UserError(f"Via repositorii directorium non est: {candidate}")

    try:
        proc = subprocess.run(
            ["git", "-C", str(candidate), "rev-parse", "--show-toplevel"],
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:
        raise UserError("Programma git non inventum. Installa Git et iterum curre.") from exc

    if proc.returncode != 0:
        raise UserError(
            f"Via repositorium Git non est: {candidate}\n"
            "Crea vel elige repositorium Git et radicem eius da."
        )

    root = Path(proc.stdout.strip()).resolve()
    if root != candidate:
        raise UserError(
            f"Via data radix Git non est: {candidate}\n"
            f"Radix detecta est: {root}\n"
            f"Curre cum --repo {root}"
        )
    return root


# TODO: Explain that a configured transcript-root variable must contain at
# least one path and that path entries use the platform path separator.
def env_paths(env: Mapping[str, str], key: str, defaults: Iterable[Path]) -> tuple[Path, ...]:
    raw = env.get(key)
    if raw is None:
        return tuple(defaults)
    paths = tuple(Path(piece).expanduser() for piece in raw.split(os.pathsep) if piece)
    if not paths:
        raise UserError(f"Variabilis {key} vacua est. Aufer eam vel saltem unam viam da.")
    return paths


def default_vscode_roots(home: Path) -> tuple[Path, ...]:
    match sys.platform:
        case "darwin":
            base = home / "Library" / "Application Support"
            local = (
                base / "Code" / "User",
                base / "Code - Insiders" / "User",
                base / "VSCodium" / "User",
            )
        case "win32":
            base = Path(os.environ.get("APPDATA", home / "AppData" / "Roaming"))
            local = (
                base / "Code" / "User",
                base / "Code - Insiders" / "User",
                base / "VSCodium" / "User",
            )
        case _:
            base = Path(os.environ.get("XDG_CONFIG_HOME", home / ".config"))
            local = (
                base / "Code" / "User",
                base / "Code - Insiders" / "User",
                base / "VSCodium" / "User",
            )
    remote = (
        home / ".vscode-server" / "data" / "User",
        home / ".vscode-server-insiders" / "data" / "User",
    )
    return local + remote


def discover_roots(env: Mapping[str, str]) -> Roots:
    home = Path.home()
    claude_default = (
        Path(env["CLAUDE_CONFIG_DIR"]).expanduser() / "projects"
        if "CLAUDE_CONFIG_DIR" in env
        else home / ".claude" / "projects"
    )
    codex_default = (
        Path(env["CODEX_HOME"]).expanduser()
        if "CODEX_HOME" in env
        else home / ".codex"
    )
    return Roots(
        claude=env_paths(env, "AI_CHAT_CLAUDE_ROOTS", (claude_default,)),
        codex=env_paths(env, "AI_CHAT_CODEX_ROOTS", (codex_default,)),
        vscode=env_paths(env, "AI_CHAT_VSCODE_USER_ROOTS", default_vscode_roots(home)),
    )


# TODO: Identify malformed or missing transcript timestamps instead of
# silently inventing chronology.
def parse_time(value: Any, fallback: dt.datetime | None = None) -> dt.datetime:
    match value:
        case int() | float():
            seconds = float(value)
            seconds = seconds / 1000.0 if abs(seconds) > 10_000_000_000 else seconds
            try:
                return dt.datetime.fromtimestamp(seconds, tz=UTC)
            except (OverflowError, OSError, ValueError) as exc:
                raise UserError(f"Tempus numericum invalidum: {value!r}") from exc
        case str():
            raw = value.strip()
            normalized = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
            try:
                parsed = dt.datetime.fromisoformat(normalized)
            except ValueError as exc:
                raise UserError(f"Tempus ISO-8601 invalidum: {value!r}") from exc
            parsed = parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed
            return parsed.astimezone(UTC)
        case None:
            if fallback is None:
                raise UserError("Tempus deest neque tempus vicarium datum est.")
            return fallback.astimezone(UTC)
        case _:
            raise UserError(f"Forma temporis ignota: {type(value).__name__}")


# TODO: Identify a transcript whose filesystem timestamp cannot be read.
def mtime(path: Path) -> dt.datetime:
    try:
        return dt.datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
    except OSError as exc:
        raise UserError(f"Tempus fasciculi legi non potest: {path}\n{exc}") from exc


# TODO: Identify unreadable or malformed JSON and tell the user which file
# must be closed, repaired, or made readable.
def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except PermissionError as exc:
        raise UserError(
            f"Licentia legendi deest: {path}\n"
            "Da terminali licentiam legendi hunc fasciculum et iterum curre."
        ) from exc
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise UserError(f"JSON invalidum in {path}: {exc}") from exc


# TODO: Identify unreadable or malformed JSONL with the exact file and line;
# advise closing transcript writers before retrying.
def read_jsonl(path: Path) -> Iterator[tuple[int, dict[str, Any]]]:
    try:
        fh = path.open("r", encoding="utf-8")
    except PermissionError as exc:
        raise UserError(
            f"Licentia legendi deest: {path}\n"
            "Da terminali licentiam legendi hunc fasciculum et iterum curre."
        ) from exc
    except OSError as exc:
        raise UserError(f"Fasciculus aperiri non potest: {path}\n{exc}") from exc

    with fh:
        for line_number, line in enumerate(fh, start=1):
            if line == "\n":
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise UserError(
                    f"JSONL invalidum: {path}:{line_number}\n{exc}\n"
                    "Claude, Codex, et VS Code claude; deinde iterum curre."
                ) from exc
            if not isinstance(record, dict):
                raise UserError(
                    f"Recordum JSONL obiectum non est: {path}:{line_number}"
                )
            yield line_number, record


def decode_file_uri(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    if not value.startswith("file://"):
        return value
    parsed = urllib.parse.urlparse(value)
    path = urllib.parse.unquote(parsed.path)
    if os.name == "nt" and len(path) >= 3 and path[0] == "/" and path[2] == ":":
        return path[1:]
    return path


def under_repo(value: str, repo: Path) -> bool:
    if not value:
        return False
    candidate = Path(decode_file_uri(value)).expanduser().resolve()
    try:
        candidate.relative_to(repo)
        return True
    except ValueError:
        return False


def exact_text(content: Any, allowed: frozenset[str]) -> str:
    """Concatenate visible text blocks without trimming or rewriting characters."""
    match content:
        case str():
            return content
        case list():
            return "".join(exact_text(item, allowed) for item in content)
        case dict():
            kind = str(content.get("type") or content.get("kind") or "")
            if kind and kind not in allowed:
                return ""
            value = content.get("text")
            if isinstance(value, str):
                return value
            value = content.get("value")
            if isinstance(value, str):
                return value
            nested = content.get("content")
            return exact_text(nested, allowed) if nested is not None else ""
        case _:
            return ""


def merge_stream(old: str, new: str) -> str:
    if new.startswith(old):
        return new
    if old.startswith(new):
        return old
    return old + new


def normalized_model(value: Any) -> str:
    match value:
        case str():
            return value
        case dict():
            for key in ("id", "modelId", "name", "label", "model"):
                candidate = value.get(key)
                if isinstance(candidate, str) and candidate:
                    return candidate
            return ""
        case _:
            return ""


def claude_messages(path: Path, repo: Path) -> list[Message]:
    messages: list[Message] = []
    streams: dict[tuple[str, str], Message] = {}
    cwd = ""
    sequence = 0
    fallback = mtime(path)

    for _, record in read_jsonl(path):
        record_type = record.get("type")
        if record_type not in {"user", "assistant"}:
            continue
        if record.get("isMeta") or record.get("isSidechain"):
            continue
        message = record.get("message")
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or record_type)
        if role not in {"user", "assistant"}:
            continue
        cwd = str(record.get("cwd") or cwd)
        if not under_repo(cwd, repo):
            continue
        allowed = frozenset({"text", "input_text", ""}) if role == "user" else frozenset({"text", "output_text", ""})
        text = exact_text(message.get("content"), allowed)
        if text == "":
            continue
        session = str(record.get("sessionId") or path.stem)
        model = normalized_model(message.get("model") or record.get("model"))
        native_id = str(record.get("uuid") or message.get("id") or "")
        item = Message(
            timestamp=parse_time(record.get("timestamp"), fallback),
            provider="Claude Code",
            role=role,
            text=text,
            session=session,
            model=model,
            cwd=cwd,
            source=path,
            sequence=sequence,
            native_id=native_id,
        )
        sequence += 1
        stream_key = (session, str(message.get("id")))
        if role == "assistant" and message.get("id"):
            previous = streams.get(stream_key)
            if previous is None:
                streams[stream_key] = item
                messages.append(item)
            else:
                previous.text = merge_stream(previous.text, text)
                previous.model = previous.model or model
        else:
            messages.append(item)
    return messages


def codex_messages(path: Path, repo: Path) -> list[Message]:
    messages: list[Message] = []
    session = path.stem
    cwd = ""
    model = ""
    sequence = 0
    fallback = mtime(path)

    for _, record in read_jsonl(path):
        kind = record.get("type")
        payload = record.get("payload")
        payload = payload if isinstance(payload, dict) else {}
        match kind:
            case "session_meta":
                thread_source = payload.get("thread_source")
                source = payload.get("source")
                source_is_subagent = (
                    isinstance(source, dict) and "subagent" in source
                )
                if thread_source in {"subagent", "automation"} or source_is_subagent:
                    return []
                session = str(payload.get("id") or payload.get("session_id") or session)
                cwd = str(payload.get("cwd") or payload.get("working_directory") or cwd)
                model = normalized_model(payload.get("model") or payload.get("model_info")) or model
            case "turn_context":
                cwd = str(payload.get("cwd") or payload.get("working_directory") or cwd)
                model = normalized_model(
                    payload.get("model") or payload.get("model_info") or payload.get("model_slug")
                ) or model
            case "response_item":
                if payload.get("type") != "message":
                    continue
                role = str(payload.get("role") or "")
                if role not in {"user", "assistant"}:
                    continue
                if not under_repo(cwd, repo):
                    continue
                allowed = frozenset({"input_text", "text", ""}) if role == "user" else frozenset({"output_text", "text", ""})
                text = exact_text(payload.get("content"), allowed)
                if text == "":
                    continue
                stripped = text.strip()
                if (
                    role == "user"
                    and stripped.startswith("<turn_aborted>")
                    and stripped.endswith("</turn_aborted>")
                ):
                    continue
                messages.append(
                    Message(
                        timestamp=parse_time(record.get("timestamp") or payload.get("timestamp"), fallback),
                        provider="Codex",
                        role=role,
                        text=text,
                        session=session,
                        model=model,
                        cwd=cwd,
                        source=path,
                        sequence=sequence,
                        native_id=str(payload.get("id") or payload.get("message_id") or ""),
                    )
                )
                sequence += 1
            case _:
                continue
    return messages


# TODO: Identify an unterminated comment in a VS Code workspace file.
def strip_jsonc_comments(text: str) -> str:
    """Remove JSONC comments while preserving every character inside strings."""
    out: list[str] = []
    i = 0
    mode = "plain"
    while i < len(text):
        pair = text[i : i + 2]
        char = text[i]
        match mode:
            case "plain":
                if char == '"':
                    mode = "string"
                    out.append(char)
                    i += 1
                elif pair == "//":
                    mode = "line"
                    out.extend("  ")
                    i += 2
                elif pair == "/*":
                    mode = "block"
                    out.extend("  ")
                    i += 2
                else:
                    out.append(char)
                    i += 1
            case "string":
                out.append(char)
                if char == "\\" and i + 1 < len(text):
                    out.append(text[i + 1])
                    i += 2
                else:
                    mode = "plain" if char == '"' else mode
                    i += 1
            case "line":
                out.append("\n" if char == "\n" else " ")
                mode = "plain" if char == "\n" else mode
                i += 1
            case "block":
                if pair == "*/":
                    out.extend("  ")
                    mode = "plain"
                    i += 2
                else:
                    out.append("\n" if char == "\n" else " ")
                    i += 1
            case _:
                raise AssertionError(mode)
    if mode == "block":
        raise UserError("Commentarium /* ... */ in fasciculo workspace non clauditur.")
    return "".join(out)


def strip_jsonc_trailing_commas(text: str) -> str:
    """Remove commas followed only by whitespace and a closing bracket/brace."""
    out: list[str] = []
    i = 0
    in_string = False
    while i < len(text):
        char = text[i]
        if char == '"':
            in_string = not in_string
            out.append(char)
            i += 1
            continue
        if in_string and char == "\\" and i + 1 < len(text):
            out.extend(text[i : i + 2])
            i += 2
            continue
        if not in_string and char == ",":
            j = i + 1
            while j < len(text) and text[j].isspace():
                j += 1
            if j < len(text) and text[j] in "]}":
                out.extend(text[i + 1 : j])
                i += 1
                continue
        out.append(char)
        i += 1
    return "".join(out)


# TODO: Identify unreadable or structurally invalid VS Code workspace files
# and the exact folder entry that prevents repository attribution.
def read_workspace_file(path: Path) -> tuple[Path, ...]:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise UserError(f"Fasciculus workspace legi non potest: {path}\n{exc}") from exc
    try:
        data = json.loads(strip_jsonc_trailing_commas(strip_jsonc_comments(raw)))
    except json.JSONDecodeError as exc:
        raise UserError(f"Fasciculus workspace invalidus est: {path}\n{exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("folders"), list):
        raise UserError(f"Fasciculus workspace indicem folders non habet: {path}")
    roots: list[Path] = []
    for item in data["folders"]:
        if not isinstance(item, dict):
            raise UserError(f"Elementum folders obiectum non est: {path}")
        raw_path = item.get("path") or decode_file_uri(item.get("uri"))
        if not isinstance(raw_path, str) or not raw_path:
            raise UserError(f"Elementum folders viam non habet: {path}")
        candidate = Path(raw_path).expanduser()
        roots.append((path.parent / candidate).resolve() if not candidate.is_absolute() else candidate.resolve())
    return tuple(roots)


# TODO: Identify malformed VS Code workspace metadata rather than guessing
# which repository owns a chat session.
def workspace_roots(storage: Path) -> tuple[Path, ...]:
    metadata = storage / "workspace.json"
    if not metadata.exists():
        return ()
    data = read_json(metadata)
    if not isinstance(data, dict):
        raise UserError(f"workspace.json obiectum non est: {metadata}")
    folder = decode_file_uri(data.get("folder"))
    if folder:
        return (Path(folder).expanduser().resolve(),)
    workspace = decode_file_uri(data.get("workspace") or data.get("configuration"))
    if workspace:
        return read_workspace_file(Path(workspace).expanduser().resolve())
    return ()


# TODO: Identify a malformed VS Code mutation path instead of repairing or
# skipping it silently.
def set_path(state: Any, keys: Sequence[Any], value: Any, delete: bool = False) -> None:
    if not keys:
        raise UserError("Mutatio VS Code viam vacuam habet.")
    target = state
    for key in keys[:-1]:
        match target:
            case list():
                target = target[key]
            case dict():
                target = target[key]
            case _:
                raise UserError("Mutatio VS Code per structuram non compositam transit.")
    final = keys[-1]
    match target:
        case list():
            if delete:
                del target[final]
            elif final == len(target):
                target.append(value)
            else:
                target[final] = value
        case dict():
            if delete:
                del target[final]
            else:
                target[final] = value
        case _:
            raise UserError("Mutatio VS Code destinatum non compositum habet.")


def get_path(state: Any, keys: Sequence[Any]) -> Any:
    target = state
    for key in keys:
        target = target[key]
    return target


# TODO: Identify an unsupported or malformed VS Code session mutation and
# direct the user to export that chat manually if the storage format changed.
def apply_vscode_mutation(state: Any, entry: dict[str, Any]) -> Any:
    kind = entry.get("kind")
    if kind == 0:
        return entry.get("v")
    if state is None:
        raise UserError("Series mutationum VS Code initium kind=0 non habet.")
    keys = entry.get("k")
    if not isinstance(keys, list):
        raise UserError("Mutatio VS Code indicem k non habet.")
    match kind:
        case 1:
            set_path(state, keys, entry.get("v"))
        case 2:
            target = get_path(state, keys)
            if not isinstance(target, list):
                raise UserError("Mutatio kind=2 indicem non petit.")
            index = entry.get("i")
            if isinstance(index, int):
                del target[index:]
            values = entry.get("v", [])
            if not isinstance(values, list):
                raise UserError("Mutatio kind=2 indicem v non habet.")
            target.extend(values)
        case 3:
            set_path(state, keys, None, delete=True)
        case _:
            raise UserError(f"Genus mutationis VS Code ignotum: {kind!r}")
    return state


# TODO: Identify a VS Code session that cannot be reconstructed into a final
# object.
def vscode_state(path: Path) -> dict[str, Any]:
    if path.suffix == ".json":
        state = read_json(path)
    else:
        state: Any = None
        for _, entry in read_jsonl(path):
            state = apply_vscode_mutation(state, entry)
    if not isinstance(state, dict):
        raise UserError(f"Sessio VS Code obiectum finale non habet: {path}")
    return state


def vscode_reply(response: Any) -> str:
    if isinstance(response, str):
        return response
    if isinstance(response, dict):
        response = [response]
    if not isinstance(response, list):
        return ""
    excluded = {
        "thinking",
        "toolInvocationSerialized",
        "toolInvocation",
        "progressMessage",
        "progressTaskSerialized",
        "textEditGroup",
        "workspaceEdit",
        "confirmation",
        "command",
        "inlineReference",
        "codeblockUri",
        "treeData",
        "extensions",
        "hook",
        "mcpServersStarting",
        "systemNotification",
    }
    parts: list[str] = []
    visible = frozenset({"", "text", "markdown", "markdownContent"})
    for item in response:
        match item:
            case str():
                parts.append(item)
            case dict():
                kind = str(item.get("kind") or item.get("type") or "")
                if kind in excluded:
                    continue
                text = exact_text(item.get("value"), visible) or exact_text(
                    item.get("content"), visible
                )
                if text != "":
                    parts.append(text)
            case _:
                continue
    return "".join(parts)


# TODO: Identify ambiguous workspace ownership or malformed VS Code requests;
# never attribute such a session to a repository by guesswork.
def vscode_messages(path: Path, storage_roots: tuple[Path, ...], repo: Path) -> list[Message]:
    state = vscode_state(path)
    working = decode_file_uri(state.get("workingDirectory"))
    if working:
        selected = under_repo(working, repo)
    else:
        inside = tuple(root for root in storage_roots if under_repo(str(root), repo))
        if inside and len(inside) != len(storage_roots):
            raise UserError(
                f"Workspace multiplex ambiguum est: {path.parent.parent}\n"
                "Sessio directorium workingDirectory non habet, et workspace radices intra atque extra repositorium continet."
            )
        selected = bool(inside)
    if not selected:
        return []

    requests = state.get("requests")
    if not isinstance(requests, list):
        raise UserError(f"Sessio VS Code indicem requests non habet: {path}")
    fallback = parse_time(state.get("creationDate"), mtime(path))
    session = str(state.get("sessionId") or state.get("id") or path.stem)
    messages: list[Message] = []
    sequence = 0
    for request in requests:
        if not isinstance(request, dict):
            raise UserError(f"Elementum requests obiectum non est: {path}")
        raw_message = request.get("message")
        match raw_message:
            case str():
                prompt = raw_message
            case dict():
                prompt = raw_message.get("text")
                if not isinstance(prompt, str):
                    raise UserError(
                        f"Rogatio VS Code textum exactum in message.text non habet: {path}"
                    )
            case _:
                raise UserError(f"Rogatio VS Code message non habet: {path}")
        model = normalized_model(request.get("modelId") or request.get("model") or request.get("agent"))
        request_id = str(request.get("requestId") or request.get("id") or sequence)
        messages.append(
            Message(
                timestamp=parse_time(request.get("timestamp"), fallback),
                provider="VS Code Chat",
                role="user",
                text=prompt,
                session=session,
                model=model,
                cwd=working,
                source=path,
                sequence=sequence,
                native_id=request_id + ":user",
            )
        )
        sequence += 1
        reply = vscode_reply(request.get("response"))
        if reply != "":
            messages.append(
                Message(
                    timestamp=parse_time(request.get("responseTimestamp") or request.get("timestamp"), fallback),
                    provider="VS Code Chat",
                    role="assistant",
                    text=reply,
                    session=session,
                    model=model,
                    cwd=working,
                    source=path,
                    sequence=sequence,
                    native_id=request_id + ":assistant",
                )
            )
            sequence += 1
    return messages


# TODO: Identify a configured transcript root that exists but is not a
# directory.
def source_files(root: Path, patterns: tuple[str, ...]) -> Iterator[Path]:
    if not root.exists():
        return
    if not root.is_dir():
        raise UserError(f"Radix transcriptuum directorium non est: {root}")
    for pattern in patterns:
        yield from sorted(path for path in root.rglob(pattern) if path.is_file())


# TODO: Identify a configured Codex root that exists but is not a directory.
def codex_files(root: Path) -> Iterator[Path]:
    if not root.exists():
        return
    if not root.is_dir():
        raise UserError(f"Radix transcriptuum directorium non est: {root}")
    if root.name in {"sessions", "archived_sessions"}:
        yield from sorted(path for path in root.rglob("*.jsonl") if path.is_file())
        return
    for dirname in ("sessions", "archived_sessions"):
        directory = root / dirname
        if directory.exists():
            yield from sorted(path for path in directory.rglob("*.jsonl") if path.is_file())


# TODO: Identify malformed VS Code workspaceStorage paths rather than silently
# treating them as absent.
def collect_messages(repo: Path, roots: Roots) -> list[Message]:
    messages: list[Message] = []
    for root in roots.claude:
        for path in source_files(root, ("*.jsonl",)):
            messages.extend(claude_messages(path, repo))
    for root in roots.codex:
        for path in codex_files(root):
            messages.extend(codex_messages(path, repo))
    for user_root in roots.vscode:
        storage_root = user_root / "workspaceStorage"
        if not storage_root.exists():
            continue
        if not storage_root.is_dir():
            raise UserError(f"workspaceStorage directorium non est: {storage_root}")
        for storage in sorted(path for path in storage_root.iterdir() if path.is_dir()):
            session_dir = storage / "chatSessions"
            if not session_dir.exists():
                continue
            roots_for_workspace = workspace_roots(storage)
            for path in sorted((*session_dir.glob("*.jsonl"), *session_dir.glob("*.json"))):
                messages.extend(vscode_messages(path, roots_for_workspace, repo))
    return messages


def pair_messages(messages: Iterable[Message]) -> list[Exchange]:
    grouped: dict[tuple[str, str, Path], list[Message]] = defaultdict(list)
    for message in messages:
        grouped[(message.provider, message.session, message.source)].append(message)

    exchanges: list[Exchange] = []
    for items in grouped.values():
        items.sort(key=lambda item: (item.sequence, item.timestamp))
        current: Exchange | None = None
        reply_parts: list[str] = []
        current_model = ""
        for item in items:
            match item.role:
                case "user":
                    if current is not None:
                        exchanges.append(dataclasses.replace(current, reply="\n\n".join(reply_parts), model=current_model))
                    current = Exchange(
                        timestamp=item.timestamp,
                        provider=item.provider,
                        model=item.model,
                        session=item.session,
                        prompt=item.text,
                        reply="",
                        source=item.source,
                    )
                    reply_parts = []
                    current_model = item.model
                case "assistant":
                    if current is None:
                        continue
                    reply_parts.append(item.text)
                    current_model = item.model or current_model
                case _:
                    raise AssertionError(item.role)
        if current is not None:
            exchanges.append(dataclasses.replace(current, reply="\n\n".join(reply_parts), model=current_model))

    unique: dict[tuple[Any, ...], Exchange] = {}
    for exchange in exchanges:
        key = (
            exchange.provider,
            exchange.session,
            exchange.timestamp,
            exchange.prompt,
            exchange.reply,
        )
        unique[key] = exchange
    return sorted(unique.values(), key=lambda item: (item.timestamp, item.provider, item.session))


def collect(repo: Path, roots: Roots) -> list[Exchange]:
    return pair_messages(collect_messages(repo, roots))


def escaped_exact(text: str) -> str:
    return html.escape(text, quote=False)


def markdown_inline(text: str) -> str:
    """Render a deliberately small, inert subset of inline Markdown."""
    escaped = html.escape(text, quote=False)
    stashed: list[str] = []

    def stash(match: re.Match[str]) -> str:
        token = f"\ue000{len(stashed)}\ue001"
        stashed.append(f"<code>{match.group(2)}</code>")
        return token

    escaped = re.sub(r"(`+)(.+?)\1", stash, escaped)
    escaped = re.sub(
        r"\[([^\]]+)\]\((https?://[^\s)]+|mailto:[^\s)]+)\)",
        lambda match: (
            f'<a href="{html.escape(match.group(2), quote=True)}">{match.group(1)}</a>'
        ),
        escaped,
    )
    escaped = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"__(.+?)__", r"<strong>\1</strong>", escaped)
    for index, fragment in enumerate(stashed):
        escaped = escaped.replace(f"\ue000{index}\ue001", fragment)
    return escaped


def markdown_html(text: str) -> str:
    """Render common assistant Markdown without accepting raw HTML."""
    lines = text.splitlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.strip() == "":
            i += 1
            continue

        fence = re.match(r"^\s*(```+|~~~+)\s*([A-Za-z0-9_.+-]*)\s*$", line)
        if fence:
            marker = fence.group(1)
            language = fence.group(2)
            i += 1
            code: list[str] = []
            while i < len(lines) and not re.match(
                rf"^\s*{re.escape(marker)}\s*$", lines[i]
            ):
                code.append(lines[i])
                i += 1
            i += 1 if i < len(lines) else 0
            attrs = (
                f' data-language="{html.escape(language, quote=True)}"'
                if language
                else ""
            )
            out.append(
                f'<pre class="code"><code{attrs}>'
                f'{html.escape("\n".join(code), quote=True)}</code></pre>'
            )
            continue

        heading = re.match(r"^(#{1,6})\s+(.+?)\s*#*\s*$", line)
        if heading:
            level = min(len(heading.group(1)) + 1, 6)
            out.append(f"<h{level}>{markdown_inline(heading.group(2))}</h{level}>")
            i += 1
            continue

        if re.match(r"^\s*[-*+]\s+", line):
            items: list[str] = []
            while i < len(lines):
                item = re.match(r"^\s*[-*+]\s+(.+)$", lines[i])
                if item is None:
                    break
                items.append(f"<li>{markdown_inline(item.group(1))}</li>")
                i += 1
            out.append("<ul>" + "".join(items) + "</ul>")
            continue

        if re.match(r"^\s*\d+[.)]\s+", line):
            items = []
            while i < len(lines):
                item = re.match(r"^\s*\d+[.)]\s+(.+)$", lines[i])
                if item is None:
                    break
                items.append(f"<li>{markdown_inline(item.group(1))}</li>")
                i += 1
            out.append("<ol>" + "".join(items) + "</ol>")
            continue

        if line.startswith(">"):
            quoted: list[str] = []
            while i < len(lines) and lines[i].startswith(">"):
                quoted.append(lines[i][1:].lstrip())
                i += 1
            out.append(
                "<blockquote><p>"
                + "<br>".join(markdown_inline(part) for part in quoted)
                + "</p></blockquote>"
            )
            continue

        paragraph = [line]
        i += 1
        while i < len(lines) and lines[i].strip() != "":
            candidate = lines[i]
            if re.match(
                r"^\s*(```+|~~~+|#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>)",
                candidate,
            ):
                break
            paragraph.append(candidate)
            i += 1
        out.append(
            "<p>" + "<br>".join(markdown_inline(part) for part in paragraph) + "</p>"
        )
    return "\n".join(out)


CSS = r"""
:root {
  color-scheme: light dark;
  --bg: #f7f8fa;
  --ink: #15171a;
  --muted: #68707a;
  --line: #dfe3e8;
  --accent: #325ea8;
  --reply: #f2f4f7;
  --measure: 52rem;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111316;
    --ink: #e8ebef;
    --muted: #9ba4af;
    --line: #303640;
    --accent: #8eb3f0;
    --reply: #1d2127;
  }
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body {
  margin: 0;
  color: var(--ink);
  background: var(--bg);
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 17px;
  line-height: 1.58;
  text-rendering: optimizeLegibility;
}
main {
  width: min(calc(100% - 2rem), var(--measure));
  margin: 0 auto;
  padding: 5.5rem 0 8rem;
}
.masthead {
  padding-bottom: 2.25rem;
  border-bottom: 1px solid var(--line);
}
h1 {
  margin: 0;
  font-size: clamp(2rem, 6vw, 3.35rem);
  line-height: 1.05;
  letter-spacing: -0.045em;
  font-weight: 720;
}
.deck, .repo-path {
  margin: .65rem 0 0;
  color: var(--muted);
  font-size: .93rem;
}
.repo-path {
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: .79rem;
}
.day {
  margin: 4.5rem 0 0;
  padding-bottom: .55rem;
  border-bottom: 1px solid var(--line);
  color: var(--muted);
  font-size: .76rem;
  font-weight: 700;
  letter-spacing: .11em;
  font-variant-numeric: tabular-nums;
}
.exchange {
  padding: 2.35rem 0 2.6rem;
  border-bottom: 1px solid var(--line);
}
.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: .35rem .65rem;
  margin-bottom: 1rem;
  color: var(--muted);
  font-size: .78rem;
  font-variant-numeric: tabular-nums;
}
.agent {
  color: var(--ink);
  font-weight: 680;
}
.model::before { content: "·"; margin-right: .65rem; color: var(--muted); }
pre {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 4;
  font: inherit;
}
.prompt {
  padding-left: 1rem;
  border-left: 3px solid var(--accent);
  font-size: 1.04rem;
  line-height: 1.62;
}
details {
  margin: 1.45rem 0 0 1rem;
  color: var(--muted);
}
summary {
  width: fit-content;
  cursor: pointer;
  user-select: none;
  color: var(--muted);
  font-size: .82rem;
  font-weight: 650;
  letter-spacing: .015em;
}
summary:hover { color: var(--accent); }
.reply {
  margin-top: 1rem;
  padding: 1.15rem 1.25rem;
  border-left: 1px solid var(--line);
  background: var(--reply);
  color: var(--ink);
  font-size: .92rem;
  line-height: 1.58;
}
.reply > :first-child { margin-top: 0; }
.reply > :last-child { margin-bottom: 0; }
.reply p { margin: .85rem 0; }
.reply h2, .reply h3, .reply h4, .reply h5, .reply h6 {
  margin: 1.4rem 0 .65rem;
  line-height: 1.25;
  letter-spacing: -.015em;
}
.reply h2 { font-size: 1.28rem; }
.reply h3 { font-size: 1.16rem; }
.reply h4, .reply h5, .reply h6 { font-size: 1rem; }
.reply ul, .reply ol { margin: .8rem 0; padding-left: 1.4rem; }
.reply li + li { margin-top: .28rem; }
.reply blockquote {
  margin: 1rem 0;
  padding-left: 1rem;
  border-left: 2px solid var(--line);
  color: var(--muted);
}
.reply code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: .88em;
}
.reply :not(pre) > code {
  padding: .12em .32em;
  border: 1px solid var(--line);
  border-radius: .25rem;
}
.reply .code {
  margin: 1rem 0;
  padding: 1rem;
  overflow-x: auto;
  white-space: pre;
  background: color-mix(in srgb, var(--bg) 72%, transparent);
  border: 1px solid var(--line);
  border-radius: .3rem;
}
.reply a { color: var(--accent); text-decoration-thickness: .08em; }
.empty { color: var(--muted); font-style: italic; }
.reply-source { display: none; }
@media (max-width: 42rem) {
  main { width: min(calc(100% - 1.25rem), var(--measure)); padding-top: 3rem; }
  .exchange { padding: 1.9rem 0 2.15rem; }
  .prompt { padding-left: .75rem; }
  details { margin-left: .75rem; }
  .reply { padding: 1rem; }
}
@media print {
  :root { --bg: white; --ink: black; --muted: #555; --line: #bbb; --reply: white; }
  main { width: 100%; padding: 0; }
  .day { break-after: avoid; }
  .exchange { break-inside: avoid; }
  details:not([open]) > :not(summary) { display: block !important; }
  summary { display: none; }
  .reply { padding-left: 1rem; }
}
"""


# TODO: Label the document as a count of human prompts over a date range, and
# label each folded AI response. The repository name/path, provider, model,
# timestamps, prompts, and replies are source data rather than generated copy.
def render(repo: Path, exchanges: Sequence[Exchange]) -> str:
    assert exchanges
    first = exchanges[0].timestamp.date().isoformat()
    last = exchanges[-1].timestamp.date().isoformat()
    count = len(exchanges)
    noun = "rogatio" if count == 1 else "rogationes"
    range_text = first if first == last else f"{first} – {last}"

    chunks: list[str] = []
    current_day = None
    for exchange in exchanges:
        local = exchange.timestamp.astimezone()
        day = local.date().isoformat()
        if day != current_day:
            chunks.append(f'<h2 class="day"><time datetime="{day}">{day}</time></h2>')
            current_day = day
        time_text = local.strftime("%H:%M:%S")
        model = f'<span class="model">{html.escape(exchange.model)}</span>' if exchange.model else ""
        if exchange.reply == "":
            reply_html = '<div class="reply empty" lang="la"><p>Responsum non inventum.</p></div>'
            reply_source = ""
        else:
            reply_html = f'<div class="reply">{markdown_html(exchange.reply)}</div>'
            reply_source = (
                f'<template class="reply-source">{html.escape(exchange.reply, quote=True)}</template>'
            )
        chunks.append(
            "\n".join(
                [
                    '<article class="exchange">',
                    '  <div class="meta">',
                    f'    <time datetime="{exchange.timestamp.isoformat()}">{time_text}</time>',
                    f'    <span class="agent">{html.escape(exchange.provider)}</span>',
                    f"    {model}",
                    "  </div>",
                    f'  <pre class="prompt">{escaped_exact(exchange.prompt)}</pre>',
                    "  <details>",
                    "    <summary>Responsum</summary>",
                    f"    {reply_html}",
                    f"    {reply_source}",
                    "  </details>",
                    "</article>",
                ]
            )
        )

    body = "\n".join(chunks)
    title = html.escape(repo.name)
    return f"""<!doctype html>
<html lang="und">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{title}</title>
<style>{CSS}</style>
</head>
<body>
<main>
<header class="masthead">
  <h1>{title}</h1>
  <p class="deck" lang="la">{count} {noun} · {range_text}</p>
  <p class="repo-path">{html.escape(str(repo))}</p>
</header>
{body}
</main>
</body>
</html>
"""


# TODO: Explain that output is never overwritten and its parent directory must
# already exist; write atomically so a partial document is never left behind.
def write_output(path: Path, page: str) -> None:
    target = path.resolve()
    if target.exists():
        raise UserError(
            f"Fasciculus iam exsistit: {target}\n"
            "Elige aliam viam cum --output, vel fasciculum veterem consulto remove."
        )
    if not target.parent.exists():
        raise UserError(
            f"Directorium output non exsistit: {target.parent}\n"
            "Crea directorium consulto, deinde iterum curre."
        )
    if not target.parent.is_dir():
        raise UserError(f"Parens output directorium non est: {target.parent}")

    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.", dir=target.parent, text=True
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
            fh.write(page)
            fh.flush()
            os.fsync(fh.fileno())
        try:
            os.link(temporary, target)
        except FileExistsError as exc:
            raise UserError(
                f"Fasciculus inter scribendum creatus est: {target}\n"
                "Fasciculus novus non superscriptus est; aliam viam cum --output elige."
            ) from exc
        temporary.unlink()
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


# TODO: Explain exactly where transcript roots were sought and how to configure
# nonstandard roots when no prompt belongs unambiguously to the repository.
def no_exchanges_error(repo: Path, roots: Roots) -> UserError:
    sought = "\n".join(f"  {path}" for path in roots.all())
    return UserError(
        f"Nullae rogationes huic repositorio attributae sunt: {repo}\n\n"
        f"Radices inspectae:\n{sought}\n\n"
        "Si transcriptus alibi sunt, variabiles AI_CHAT_CLAUDE_ROOTS, "
        "AI_CHAT_CODEX_ROOTS, vel AI_CHAT_VSCODE_USER_ROOTS constitue.\n"
        "VS Code: repositorium ipsum ut folder aperi; workspace multiplex sine "
        "workingDirectory attributionem exactam impedire potest."
    )


# TODO: Report success with the exact output path and number of exported prompts;
# report actionable failures without creating an empty or partial document.
def run(argv: Sequence[str] | None = None, env: Mapping[str, str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    environment = os.environ if env is None else env
    try:
        options = parse_args(args)
        repo = canonical_repo(options.repo)
        roots = discover_roots(environment)
        exchanges = collect(repo, roots)
        if not exchanges:
            raise no_exchanges_error(repo, roots)
        page = render(repo, exchanges)
        write_output(options.output, page)
        output = options.output.resolve()
        print(f"Scriptum: {output}\nRogationes: {len(exchanges)}")
        if options.open_after:
            opened = webbrowser.open(output.as_uri())
            if not opened:
                raise UserError(f"Navigatrum fasciculum aperire recusavit: {output}")
        return 0
    except ExitMessage as exc:
        print(exc)
        return 0
    except UserError as exc:
        print(f"Error:\n{exc}", file=sys.stderr)
        return 2


def main() -> int:
    return run()


if __name__ == "__main__":
    raise SystemExit(main())
