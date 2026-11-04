"""Project-owned, agent-neutral reading assets; no central mutable index."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import tempfile
from uuid import uuid4

CONFIG = ".zotero-lattics.json"
DEFAULT_DIR = "Zotero文献缓存"


def project_path(root, relative):
    root = Path(root).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("Project root must be an existing directory")
    if Path(relative).is_absolute() or not relative or ".." in Path(relative).parts:
        raise ValueError("Cache directory must be a relative path within the project")
    target = (root / relative).resolve()
    if target == root or root not in target.parents:
        raise ValueError("Cache directory must be inside the project")
    return root, target


def create_record(path, data):
    """Publish a complete file without replacing another agent's file."""
    path = Path(path)
    fd, pending = tempfile.mkstemp(dir=path.parent, prefix=".pending-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
        os.link(pending, path)
    finally:
        os.unlink(pending)


def get_project(root):
    root = Path(root).expanduser().resolve(strict=True)
    data = json.loads((root / CONFIG).read_text(encoding="utf-8"))
    if data.get("schema_version") != 1:
        raise ValueError("Unsupported project cache configuration")
    root, cache = project_path(root, data["cache_dir"])
    return {"project_root": str(root), "cache_root": str(cache),
            "papers_root": str(cache / "papers"), "config": str(root / CONFIG)}


def init_project(project_root, cache_dir=None):
    root = Path(project_root).expanduser().resolve(strict=True)
    config = root / CONFIG
    if config.exists():
        existing = get_project(root)
        if cache_dir is not None and project_path(root, cache_dir)[1] != Path(existing["cache_root"]):
            raise ValueError("Project already has a cache location; do not silently relocate it")
        return existing
    root, cache = project_path(root, cache_dir or DEFAULT_DIR)
    record = {"schema_version": 1, "cache_dir": cache.relative_to(root).as_posix()}
    try:
        create_record(config, record)
    except FileExistsError:
        return init_project(root, cache_dir or DEFAULT_DIR)
    return get_project(root)


def discover_project(start=None):
    current = Path(start or Path.cwd()).expanduser().resolve()
    if current.is_file():
        current = current.parent
    for root in (current, *current.parents):
        if (root / CONFIG).exists():
            return get_project(root)
    return None


def resolve_cache(project_root=None, cache_root=None, standalone=False):
    if project_root is not None:
        if cache_root is not None or standalone:
            raise ValueError("Use the registered project cache; do not combine cache overrides")
        return Path(get_project(project_root)["papers_root"])
    if cache_root is not None:
        if standalone:
            raise ValueError("Choose cache_root or standalone")
        return Path(cache_root).expanduser().resolve()
    if standalone:
        return Path.home() / ".agents/state/zotero-lattics/papers"
    project = discover_project()
    if project:
        return Path(project["papers_root"])
    raise ValueError("No project cache registered. Use init-project and --project-root; --standalone is only for projectless reading.")


def list_papers(project_root):
    project = get_project(project_root)
    root = Path(project["cache_root"])
    entries = []
    for paper in sorted((root / "papers").glob("*/*/*/*/paper.json")):
        try:
            data = json.loads(paper.read_text(encoding="utf-8"))
            entries.append({"paper": paper.relative_to(root).as_posix(),
                            "library_id": data["library_id"], "item_key": data["item_key"],
                            "attachment_key": data["attachment_key"], "pdf_sha256": data["pdf_sha256"],
                            "readings": [p.relative_to(root).as_posix() for p in sorted((paper.parent / "readings").glob("*.json"))],
                            "pdf_status": "not_checked_until_read"})
        except (ValueError, KeyError, OSError) as exc:
            entries.append({"paper": paper.relative_to(root).as_posix(), "error": str(exc)})
    return {**project, "papers": entries}


def save_reading(paper, data, reading, agent):
    if not isinstance(reading, dict) or not isinstance(reading.get("summary"), str) or not reading["summary"].strip():
        raise ValueError("Reading must contain a nonempty summary")
    ids = reading.get("read_block_ids")
    known = {b["id"] for p in data["pages"] for b in p["blocks"]}
    if not isinstance(ids, list) or not ids or not all(isinstance(i, str) and i in known for i in ids):
        raise ValueError("Reading must identify valid read_block_ids; this does not certify comprehension")
    if not agent.strip():
        raise ValueError("Identify the agent that produced this reading")
    record = {"record_version": 1, "created_at": datetime.now(timezone.utc).isoformat(),
              "agent": agent, "status": "ai_unverified", "pdf_sha256": data["pdf_sha256"],
              "reader_version": data["reader_version"], "library_id": data["library_id"],
              "item_key": data["item_key"], "attachment_key": data["attachment_key"], "reading": reading}
    directory = Path(paper).resolve().parent / "readings"
    directory.mkdir(exist_ok=True)
    path = directory / (uuid4().hex + ".json")
    create_record(path, record)
    return {"reading": str(path), "status": record["status"], "pdf_sha256": data["pdf_sha256"]}
