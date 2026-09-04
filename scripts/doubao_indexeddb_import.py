#!/usr/bin/env python3
"""Build AgentXRay's read-only Doubao cache from a Chromium IndexedDB snapshot.

Only a narrow allow-list is persisted: project/session identifiers, names and
workspace roots, message text/tool summaries, timestamps, section identifiers,
and model names.
Raw request metadata (cookies, tokens, IPs, device IDs, log IDs) is never stored.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = "3"


def js_values(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        values = value.get("values")
        props = value.get("properties")
        if isinstance(props, dict) and props:
            def key(item: tuple[str, Any]) -> tuple[int, str]:
                return (0, f"{int(item[0]):020d}") if item[0].isdigit() else (1, item[0])
            property_values = [v for _, v in sorted(props.items(), key=key)]
            useful_properties = [v for v in property_values if not (isinstance(v, dict) and v.get("__type__") in {"Undefined", "Null"})]
            useful_values = [v for v in values or [] if not (isinstance(v, dict) and v.get("__type__") in {"Undefined", "Null"})]
            if useful_properties and len(useful_properties) >= len(useful_values):
                return property_values
        if isinstance(values, list):
            return values
    return []


def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def parse_json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def iso_time(value: Any) -> str | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value) if isinstance(value, str) and value else None
    if number > 10_000_000_000:
        number /= 1000.0
    from datetime import datetime, timezone
    try:
        return datetime.fromtimestamp(number, timezone.utc).isoformat().replace("+00:00", "Z")
    except (OverflowError, OSError, ValueError):
        return None


def key_value(record: dict[str, Any]) -> Any:
    key = as_dict(record.get("key"))
    for field in ("encoded_user_key", "user_key"):
        item = as_dict(key.get(field))
        if "value" in item:
            return item.get("value")
    return None


def iter_payloads(record: dict[str, Any]) -> Iterable[tuple[str, dict[str, Any]]]:
    value = as_dict(record.get("value"))
    inline = value.get("value") if value.get("__type__") == "ObjectStoreDataValue" else None
    if isinstance(inline, dict):
        yield "inline", inline
    for blob in record.get("blobs") or []:
        if isinstance(blob, list) and len(blob) > 1 and isinstance(blob[1], dict):
            yield "blob", blob[1]
        elif isinstance(blob, dict):
            yield "blob", blob


def extract_text_and_tools(message: dict[str, Any]) -> list[dict[str, Any]]:
    extra = as_dict(message.get("extra"))
    blocks = message.get("content_blocks_v2") or extra.get("content_blocks_v2")
    parts: list[dict[str, Any]] = []
    for block in js_values(blocks):
        if not isinstance(block, dict):
            continue
        content = as_dict(block.get("content"))
        text = as_dict(content.get("text_block")).get("text")
        if isinstance(text, str) and text:
            parts.append({"type": "text", "text": text})
            continue
        generic = as_dict(content.get("generic_tool_block"))
        file_op = as_dict(content.get("file_operation_block"))
        if generic:
            parts.append({
                "type": "toolCall",
                "id": str(block.get("block_id") or ""),
                "name": str(generic.get("tool_name") or generic.get("title") or "tool"),
                "arguments": None,
                "status": generic.get("status"),
                "summary": generic.get("summary") or generic.get("title"),
            })
        elif file_op:
            header = as_dict(file_op.get("header"))
            summary = header.get("summary")
            path = file_op.get("path")
            content_text = file_op.get("content")
            parts.append({
                "type": "toolCall",
                "id": str(block.get("block_id") or ""),
                "name": "Bash" if "运行" in str(summary or "") else "file_operation",
                "arguments": None,
                "status": file_op.get("status"),
                "summary": summary,
                "path": path if isinstance(path, str) and path else None,
                "fileName": file_op.get("file_name") if isinstance(file_op.get("file_name"), str) else None,
                "fileType": file_op.get("file_type") if isinstance(file_op.get("file_type"), str) else None,
                "content": content_text if isinstance(content_text, str) and content_text else None,
            })
    return parts


def message_model_key(message: dict[str, Any], fallback: str | None) -> str | None:
    ext = as_dict(as_dict(message.get("extra")).get("ext"))
    value = ext.get("model_item_key")
    return str(value) if value not in (None, "") else fallback


def parse_general_task_param(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    return parse_json_object(value)


def task_context(task: dict[str, Any]) -> dict[str, str | None]:
    request = as_dict(as_dict(as_dict(task.get("requestQuery")).get("syncTask")))
    client_meta = as_dict(request.get("client_meta"))
    option = as_dict(request.get("option"))
    init_option = as_dict(option.get("conversation_init_option"))
    model_config = as_dict(option.get("model_config"))
    general_task_param = parse_general_task_param(option.get("general_task_param"))
    client_option = as_dict(general_task_param.get("client_option"))
    agent_task_param = as_dict(general_task_param.get("agent_task_param"))
    conversation_id = client_meta.get("conversation_id")
    project_id = init_option.get("project_id")
    project_path = client_option.get("workspace") or agent_task_param.get("workspace")
    section_id = client_meta.get("section_id")
    model_key = model_config.get("model_item_key")

    for message in as_dict(task.get("sentMessages")).values():
        if not isinstance(message, dict):
            continue
        extra = as_dict(message.get("extra"))
        ext = as_dict(extra.get("ext"))
        conversation_id = conversation_id or message.get("conversationId") or extra.get("conversation_id")
        section_id = section_id or extra.get("section_id")
        model_key = model_key or ext.get("model_item_key")
        init = parse_json_object(ext.get("conversation_init_option"))
        project_id = project_id or init.get("project_id")
        message_general_param = parse_general_task_param(ext.get("general_task_param"))
        message_client_option = as_dict(message_general_param.get("client_option"))
        message_agent_task_param = as_dict(message_general_param.get("agent_task_param"))
        project_path = (
            project_path
            or message_client_option.get("workspace")
            or message_agent_task_param.get("workspace")
        )
        ack = parse_json_object(ext.get("ack_client_meta"))
        conversation_id = conversation_id or ack.get("conversation_id")
        section_id = section_id or ack.get("section_id")
        if conversation_id and project_id and project_path and section_id and model_key:
            break
    return {
        "conversation_id": str(conversation_id) if conversation_id else None,
        "project_id": str(project_id) if project_id else None,
        "project_path": str(project_path) if project_path else None,
        "section_id": str(section_id) if section_id else None,
        "model_key": str(model_key) if model_key not in (None, "") else None,
    }


def extract_models(payload: dict[str, Any], output: dict[str, str]) -> None:
    def walk(value: Any) -> None:
        if isinstance(value, dict):
            key = value.get("model_item_key")
            name = value.get("name") or value.get("selected_name")
            if key not in (None, "") and isinstance(name, str) and name:
                output[str(key)] = name
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)
    walk(payload)


def extract_projects(payload: dict[str, Any], sequence: int, projects: dict[str, dict[str, Any]], sessions: dict[str, dict[str, Any]]) -> None:
    data = as_dict(payload.get("data"))
    for project in js_values(data.get("projects")):
        if not isinstance(project, dict):
            continue
        project_id = project.get("projectId") or project.get("project_id")
        if not project_id:
            continue
        project_id = str(project_id)
        current = projects.get(project_id)
        if not current or sequence >= current["sequence"]:
            projects[project_id] = {
                "id": project_id,
                "name": str(project.get("name") or project_id),
                "root_path": current.get("root_path") if current else None,
                "root_path_sequence": int(current.get("root_path_sequence", -1)) if current else -1,
                "display_order": int(project.get("displayOrder") or 0),
                "sequence": sequence,
            }
        for conversation in js_values(project.get("conversations")):
            if not isinstance(conversation, dict):
                continue
            conversation_id = conversation.get("conversationId") or conversation.get("conversation_id")
            if not conversation_id:
                continue
            conversation_id = str(conversation_id)
            existing = sessions.setdefault(conversation_id, {"id": conversation_id, "sequence": -1})
            if sequence >= int(existing.get("directory_sequence", -1)):
                existing.update({
                    "project_id": project_id,
                    "title": str(conversation.get("name") or "") or None,
                    "directory_sequence": sequence,
                })


def upsert_message(messages: dict[str, dict[str, Any]], item: dict[str, Any]) -> None:
    current = messages.get(item["id"])
    if current is None or (item["sequence"], item["sort_index"]) >= (current["sequence"], current["sort_index"]):
        messages[item["id"]] = item


def extract_task_state(
    payload: dict[str, Any],
    sequence: int,
    projects: dict[str, dict[str, Any]],
    sessions: dict[str, dict[str, Any]],
    messages: dict[str, dict[str, Any]],
) -> None:
    state = as_dict(payload.get("state")) or payload
    tasks = as_dict(state.get("mainTaskDataMap"))
    for task_id, task_value in tasks.items():
        task = as_dict(task_value)
        ctx = task_context(task)
        conversation_id = ctx["conversation_id"]
        if not conversation_id:
            continue
        session = sessions.setdefault(conversation_id, {"id": conversation_id, "sequence": -1})
        session["project_id"] = ctx["project_id"] or session.get("project_id")
        session["project_path"] = ctx["project_path"] or session.get("project_path")
        if session.get("project_id") and session.get("project_path"):
            project = projects.setdefault(
                session["project_id"],
                {
                    "id": session["project_id"],
                    "name": session["project_id"],
                    "root_path": None,
                    "root_path_sequence": -1,
                    "display_order": 0,
                    "sequence": -1,
                },
            )
            if sequence >= int(project.get("root_path_sequence", -1)):
                project["root_path"] = session["project_path"]
                project["root_path_sequence"] = sequence
        session["section_id"] = ctx["section_id"] or session.get("section_id")
        session["model_key"] = ctx["model_key"] or session.get("model_key")
        session["sequence"] = max(int(session.get("sequence", -1)), sequence)
        session["source_task_id"] = str(task.get("sessionId") or task_id)

        role_maps = (("user", as_dict(task.get("sentMessages"))), ("assistant", as_dict(task.get("receivedMessages"))))
        for role, mapping in role_maps:
            for index, (message_id, value) in enumerate(mapping.items()):
                message = as_dict(value)
                extra = as_dict(message.get("extra"))
                parts = extract_text_and_tools(message)
                if not parts:
                    continue
                actual_id = extra.get("message_id") or message.get("messageId") or message_id
                timestamp = iso_time(extra.get("create_time") or task.get("querySendTimestamp") or task.get("createTime"))
                section_id = extra.get("section_id") or ctx["section_id"]
                message_key = message_model_key(message, ctx["model_key"])
                upsert_message(messages, {
                    "id": str(actual_id),
                    "conversation_id": conversation_id,
                    "session_id": str(extra.get("session_id") or message.get("sessionId") or task_id),
                    "section_id": str(section_id) if section_id else None,
                    "role": role,
                    "timestamp": timestamp,
                    "model_key": message_key,
                    "content": parts,
                    "sort_index": int(extra.get("index") or index),
                    "sequence": sequence,
                })


def open_database(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.executescript("""
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT, display_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY, project_id TEXT, title TEXT, section_id TEXT,
            created_at TEXT, updated_at TEXT, model TEXT, model_key TEXT,
            source_path TEXT NOT NULL, source_task_id TEXT, source_sequence INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, session_id TEXT,
            section_id TEXT, role TEXT NOT NULL, timestamp TEXT, model TEXT,
            model_key TEXT, content_json TEXT NOT NULL, sort_index INTEGER NOT NULL DEFAULT 0,
            source_sequence INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, timestamp, sort_index);
        CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, updated_at);
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            message_id UNINDEXED, conversation_id UNINDEXED, role UNINDEXED, text
        );
    """)
    return connection


def merge_message_content(current: list[Any], cached: list[Any]) -> list[Any]:
    """Enrich current parts while retaining tool calls pruned from a later UI snapshot."""
    merged = [dict(part) if isinstance(part, dict) else part for part in current]
    indexed = {
        str(part.get("id")): index
        for index, part in enumerate(merged)
        if isinstance(part, dict) and part.get("id") not in (None, "")
    }
    for cached_part in cached:
        if not isinstance(cached_part, dict):
            continue
        part_id = cached_part.get("id")
        if part_id in (None, ""):
            continue
        key = str(part_id)
        if key not in indexed:
            indexed[key] = len(merged)
            merged.append(dict(cached_part))
            continue
        current_part = merged[indexed[key]]
        if not isinstance(current_part, dict):
            continue
        for field, value in cached_part.items():
            if current_part.get(field) in (None, "", [], {}) and value not in (None, "", [], {}):
                current_part[field] = value
    return merged


def merge_existing_cache(
    output: Path,
    projects: dict[str, dict[str, Any]],
    sessions: dict[str, dict[str, Any]],
    messages: dict[str, dict[str, Any]],
    models: dict[str, str],
) -> None:
    """Retain audit history that Chromium no longer exposes in the latest snapshot."""
    if not output.is_file():
        return
    db = sqlite3.connect(f"file:{output}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        tables = {row["name"] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"projects", "sessions", "messages"}.issubset(tables):
            return
        project_columns = {row["name"] for row in db.execute("PRAGMA table_info(projects)")}
        project_select = "SELECT id,name,root_path,display_order FROM projects" if "root_path" in project_columns else "SELECT id,name,display_order FROM projects"
        for row in db.execute(project_select):
            projects.setdefault(
                row["id"],
                {
                    "id": row["id"],
                    "name": row["name"],
                    "root_path": row["root_path"] if "root_path" in project_columns else None,
                    "root_path_sequence": -1,
                    "display_order": row["display_order"],
                    "sequence": -1,
                },
            )
            if projects[row["id"]].get("root_path") in (None, "") and "root_path" in project_columns:
                projects[row["id"]]["root_path"] = row["root_path"]
        for row in db.execute("SELECT * FROM sessions"):
            current = sessions.setdefault(row["id"], {"id": row["id"], "sequence": -1})
            for key in ("project_id", "title", "section_id", "model", "model_key", "source_task_id"):
                if current.get(key) in (None, "") and row[key] not in (None, ""):
                    current[key] = row[key]
            current["created_at"] = current.get("created_at") or row["created_at"]
            current["updated_at"] = current.get("updated_at") or row["updated_at"]
            current["sequence"] = max(int(current.get("sequence", -1)), int(row["source_sequence"] or -1))
            if row["model_key"] and row["model"]:
                models.setdefault(row["model_key"], row["model"])
        for row in db.execute("SELECT * FROM messages"):
            content = json.loads(row["content_json"])
            cached_content = content if isinstance(content, list) else []
            current = messages.get(row["id"])
            if current is not None:
                current["content"] = merge_message_content(current.get("content") or [], cached_content)
                continue
            upsert_message(messages, {
                "id": row["id"],
                "conversation_id": row["conversation_id"],
                "session_id": row["session_id"],
                "section_id": row["section_id"],
                "role": row["role"],
                "timestamp": row["timestamp"],
                "model": row["model"],
                "model_key": row["model_key"],
                "content": cached_content,
                "sort_index": int(row["sort_index"] or 0),
                "sequence": int(row["source_sequence"] or 0),
            })
    finally:
        db.close()


def write_cache(output: Path, source: Path, projects: dict[str, dict[str, Any]], sessions: dict[str, dict[str, Any]], messages: dict[str, dict[str, Any]], models: dict[str, str], warning_count: int) -> None:
    merge_existing_cache(output, projects, sessions, messages, models)
    temp_output = output.with_suffix(output.suffix + ".next")
    for extra in (temp_output, Path(str(temp_output) + "-wal"), Path(str(temp_output) + "-shm")):
        extra.unlink(missing_ok=True)
    db = open_database(temp_output)
    try:
        with db:
            db.execute("DELETE FROM projects")
            db.execute("DELETE FROM sessions")
            db.execute("DELETE FROM messages")
            db.execute("DELETE FROM messages_fts")
            for project in projects.values():
                db.execute(
                    "INSERT INTO projects(id,name,root_path,display_order) VALUES(?,?,?,?)",
                    (project["id"], project["name"], project.get("root_path"), project["display_order"]),
                )
            by_conversation: dict[str, list[dict[str, Any]]] = {}
            for message in messages.values():
                message["model"] = models.get(message.get("model_key") or "") or message.get("model")
                by_conversation.setdefault(message["conversation_id"], []).append(message)
            for conversation_id, session in sessions.items():
                conversation_messages = by_conversation.get(conversation_id, [])
                times = sorted(m["timestamp"] for m in conversation_messages if m.get("timestamp"))
                created_candidates = [value for value in (times[0] if times else None, session.get("created_at")) if value]
                updated_candidates = [value for value in (times[-1] if times else None, session.get("updated_at")) if value]
                created_at = min(created_candidates) if created_candidates else None
                updated_at = max(updated_candidates) if updated_candidates else created_at
                ordered_messages = sorted(
                    conversation_messages,
                    key=lambda item: (item.get("timestamp") or "", int(item.get("sequence", 0)), int(item.get("sort_index", 0))),
                )
                model_keys = [m.get("model_key") for m in ordered_messages if m.get("model_key")]
                model_key = model_keys[-1] if model_keys else session.get("model_key")
                model = models.get(model_key or "") or session.get("model")
                db.execute(
                    """INSERT INTO sessions(id,project_id,title,section_id,created_at,updated_at,model,model_key,source_path,source_task_id,source_sequence)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                    (conversation_id, session.get("project_id"), session.get("title"), session.get("section_id"),
                     created_at, updated_at, model, model_key,
                     str(source), session.get("source_task_id"), int(session.get("sequence", 0))),
                )
            for message in messages.values():
                content_json = json.dumps(message["content"], ensure_ascii=False, separators=(",", ":"))
                db.execute(
                    """INSERT INTO messages(id,conversation_id,session_id,section_id,role,timestamp,model,model_key,content_json,sort_index,source_sequence)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                    (message["id"], message["conversation_id"], message.get("session_id"), message.get("section_id"), message["role"],
                     message.get("timestamp"), message.get("model"), message.get("model_key"), content_json, message["sort_index"], message["sequence"]),
                )
                text = "\n".join(str(part.get("text") or part.get("summary") or "") for part in message["content"] if isinstance(part, dict))
                db.execute("INSERT INTO messages_fts(message_id,conversation_id,role,text) VALUES(?,?,?,?)", (message["id"], message["conversation_id"], message["role"], text))
            metadata = {
                "schema_version": SCHEMA_VERSION,
                "source_path": str(source),
                "project_count": str(len(projects)),
                "session_count": str(len(sessions)),
                "message_count": str(len(messages)),
                "model_count": str(len(models)),
                "parser_warning_count": str(warning_count),
            }
            db.executemany("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", metadata.items())
    finally:
        db.close()
    output.parent.mkdir(parents=True, exist_ok=True)
    os.replace(temp_output, output)


def snapshot_source(source: Path, destination: Path) -> Path:
    destination.mkdir(parents=True, exist_ok=True)
    leveldb_target = destination / source.name
    shutil.copytree(source, leveldb_target)
    if source.name.endswith(".leveldb"):
        blob_source = source.with_name(source.name[:-len(".leveldb")] + ".blob")
        if blob_source.is_dir():
            shutil.copytree(blob_source, destination / blob_source.name)
    return leveldb_target


def run_export(dfindexeddb: str, source: Path, jsonl_path: Path, error_path: Path) -> int:
    command = [dfindexeddb, "db", "-s", str(source), "-f", "chromium", "--use_manifest", "--load_blobs", "-o", "jsonl"]
    with jsonl_path.open("w", encoding="utf-8") as stdout, error_path.open("w", encoding="utf-8") as stderr:
        result = subprocess.run(command, stdout=stdout, stderr=stderr, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"dfindexeddb failed with exit code {result.returncode}; see {error_path}")
    return sum(1 for line in error_path.read_text(errors="replace").splitlines() if line.strip())


def build_cache(records_path: Path, output: Path, source: Path, warning_count: int = 0) -> None:
    projects: dict[str, dict[str, Any]] = {}
    sessions: dict[str, dict[str, Any]] = {}
    messages: dict[str, dict[str, Any]] = {}
    models: dict[str, str] = {}
    bad_lines = 0
    with records_path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                bad_lines += 1
                continue
            sequence = int(record.get("sequence_number") or 0)
            for source_kind, payload in iter_payloads(record):
                if source_kind == "inline":
                    extract_projects(payload, sequence, projects, sessions)
                    extract_models(payload, models)
                if source_kind == "blob" or "mainTaskDataMap" in json.dumps(payload, ensure_ascii=False)[:1000]:
                    extract_task_state(payload, sequence, projects, sessions, messages)
    if bad_lines:
        raise RuntimeError(f"dfindexeddb emitted {bad_lines} invalid JSONL records")
    write_cache(output, source, projects, sessions, messages, models, warning_count)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True, help="chrome_doubao-chat_0.indexeddb.leveldb")
    parser.add_argument("--output", type=Path, required=True, help="AgentXRay derived SQLite cache")
    parser.add_argument("--dfindexeddb", default="dfindexeddb", help="path to the dfindexeddb executable")
    parser.add_argument("--records", type=Path, help="use an existing dfindexeddb JSONL export (tests/spikes)")
    args = parser.parse_args()

    source = args.source.expanduser().resolve()
    output = args.output.expanduser().resolve()
    if not source.is_dir() and not args.records:
        parser.error(f"IndexedDB source does not exist: {source}")

    if args.records:
        build_cache(args.records.resolve(), output, source)
    else:
        with tempfile.TemporaryDirectory(prefix="agentxray-doubao-") as tmp:
            root = Path(tmp)
            snapshot = snapshot_source(source, root / "IndexedDB")
            records = root / "records.jsonl"
            errors = root / "dfindexeddb.log"
            warning_count = run_export(args.dfindexeddb, snapshot, records, errors)
            build_cache(records, output, source, warning_count)
    print(json.dumps({"cache": str(output), "source": str(source)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
