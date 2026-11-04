#!/usr/bin/env python3
"""Local, read-only PDF reader. Delivered text is not proof of comprehension."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

import fitz
import project_cache

VERSION = "1-" + fitz.VersionBind
DEFAULT_CACHE = Path.home() / ".agents/state/zotero-lattics/papers"


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def atomic_write(path, text):
    path = Path(path)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".pending-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(text)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def prepare(pdf, item_key, attachment_key, library_id="local", cache_root=None, project_root=None, standalone=False):
    pdf = Path(pdf).expanduser().resolve(strict=True)
    cache_root = project_cache.resolve_cache(project_root, cache_root, standalone)
    for value in (item_key, attachment_key, library_id):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
            raise ValueError("Library and item identifiers must contain only letters, digits, _ or -")
    fingerprint = digest(pdf)
    folder = Path(cache_root).expanduser() / library_id / item_key / attachment_key / (fingerprint + "-" + VERSION)
    manifest = folder / "paper.json"
    if manifest.exists():
        saved = json.loads(manifest.read_text(encoding="utf-8"))
        md = folder / "fulltext.md"
        if saved["pdf_path"] == str(pdf) and md.exists() and digest(md) == saved["markdown_sha256"]:
            return {"paper": str(manifest), "markdown": str(md), "cache_hit": True,
                    "page_count": saved["page_count"], "warnings": saved["warnings"]}
    with fitz.open(pdf) as doc:
        if doc.needs_pass:
            raise ValueError("PDF is encrypted; obtain a readable copy first")
        pages = []
        warnings = ["Native PDF text-block order is retained; columns, tables and OCR must be checked against the PDF."]
        for page_index, page in enumerate(doc):
            blocks = []
            for entry in page.get_text("blocks", sort=False):
                if entry[6] != 0 or not entry[4].strip():
                    continue
                blocks.append({"id": f"p{page_index + 1:04d}-b{len(blocks) + 1:04d}",
                               "page": page_index + 1, "bbox": list(entry[:4]),
                               "source_text": entry[4]})
            count = sum(len(b["source_text"].strip()) for b in blocks)
            flags = []
            if count < 80:
                flags.append("sparse_or_no_text")
            if any("\ufffd" in b["source_text"] for b in blocks):
                flags.append("replacement_characters")
            if flags:
                warnings.append(f"Page {page_index + 1}: {', '.join(flags)}; inspect page image.")
            pages.append({"page": page_index + 1, "page_label": page.get_label() or str(page_index + 1),
                          "flags": flags, "blocks": blocks})
        toc = [row for row in doc.get_toc() if 1 <= row[2] <= len(doc)]
        sections = []
        for i, (level, title, start) in enumerate(toc):
            next_page = next((r[2] for r in toc[i + 1:] if r[0] <= level and r[2] >= start), len(doc) + 1)
            # Include the next section's start page: headings can split a physical page.
            sections.append({"id": f"s{i + 1}", "title": title, "level": level,
                             "start_page": start, "end_page": min(len(doc), next_page)})
        if not sections:
            warnings.append("No PDF bookmarks: use page/block navigation; no automatic chapter claims.")
    if digest(pdf) != fingerprint:
        raise ValueError("PDF changed during extraction; prepare again")
    data = {"reader_version": VERSION, "pdf_path": str(pdf), "pdf_sha256": fingerprint,
            "item_key": item_key, "attachment_key": attachment_key, "library_id": library_id,
            "page_count": len(pages), "sections": sections, "pages": pages, "warnings": warnings}
    md = ["# PDF 阅读副本", "", "原生文本块次序；未进行 OCR、改写或纠错。页码为 PDF 物理页码。",
          "完整提取不等于完整阅读或语义核验。原始 PDF 为真值源。", ""]
    for page in pages:
        md.extend([f"## PDF 第 {page['page']} 页", ""])
        for block in page["blocks"]:
            md.extend([f"<!-- {block['id']} -->", block["source_text"], ""])
    markdown = "\n".join(md)
    data["markdown_sha256"] = hashlib.sha256(markdown.encode()).hexdigest()
    folder.mkdir(parents=True, exist_ok=True)
    atomic_write(folder / "fulltext.md", markdown)
    atomic_write(manifest, json.dumps(data, ensure_ascii=False, indent=2))
    return {"paper": str(manifest), "markdown": str(folder / "fulltext.md"), "cache_hit": False,
            "page_count": len(pages), "warnings": warnings}


def load_paper(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if data["reader_version"] != VERSION or digest(data["pdf_path"]) != data["pdf_sha256"]:
        raise ValueError("PDF or reader version changed; run prepare again")
    return data


def read_text(data, pages=None, section=None, cursor=0, max_chars=16000):
    if pages and section:
        raise ValueError("Choose pages or section, not both")
    selected = set(range(1, data["page_count"] + 1))
    if pages:
        selected = set()
        for part in pages.split(","):
            if not re.fullmatch(r"\d+(?:-\d+)?", part):
                raise ValueError("Use physical pages such as 1-3,5")
            ends = [int(n) for n in part.split("-")]
            if ends[0] > ends[-1]:
                raise ValueError("Reversed page range")
            selected.update(range(ends[0], ends[-1] + 1))
        if not selected or min(selected) < 1 or max(selected) > data["page_count"]:
            raise ValueError("Page selection is outside the PDF")
    if section:
        matches = [s for s in data["sections"] if s["id"] == section]
        if not matches:
            raise ValueError("Unknown section; inspect sections or use physical pages")
        s = matches[0]
        selected = set(range(s["start_page"], s["end_page"] + 1))
    blocks = [b for p in data["pages"] if p["page"] in selected for b in p["blocks"]]
    if not 0 <= cursor <= len(blocks) or max_chars < 1:
        raise ValueError("Invalid cursor or max_chars")
    batch, size, end = [], 0, cursor
    while end < len(blocks):
        block = blocks[end]
        if batch and size + len(block["source_text"]) > max_chars:
            break
        batch.append(block)
        size += len(block["source_text"])
        end += 1
    return {"pdf_sha256": data["pdf_sha256"], "selected_pages": sorted(selected),
            "cursor": cursor, "next_cursor": end if end < len(blocks) else None,
            "selection_end_reached": end == len(blocks), "total_selected_blocks": len(blocks),
            "returned_chars": size, "blocks": batch, "warnings": data["warnings"],
            "note": "Keep the same page/section selection when continuing. Whole blocks may exceed max_chars. Delivery does not certify reading or support."}


def locate_block(data, block_id, text=None):
    from locate_pdf_text import locate
    block = next((b for p in data["pages"] for b in p["blocks"] if b["id"] == block_id), None)
    if block is None:
        raise ValueError("Unknown block ID")
    source = block["source_text"].strip() if text is None else text.strip()
    if not source or source not in block["source_text"]:
        raise ValueError("Excerpt must be an unchanged substring of source_text")
    return locate(Path(data["pdf_path"]), source, data["attachment_key"], block["page"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--pdf", required=True)
    p.add_argument("--item-key", required=True)
    p.add_argument("--attachment-key", required=True)
    p.add_argument("--library-id", default="local")
    p.add_argument("--cache-root", type=Path)
    p.add_argument("--project-root", type=Path)
    p.add_argument("--standalone", action="store_true")
    p = sub.add_parser("init-project")
    p.add_argument("--project-root", type=Path, required=True)
    p.add_argument("--cache-dir")
    p = sub.add_parser("list-papers")
    p.add_argument("--project-root", type=Path, required=True)
    for command in ("inspect", "read", "locate", "save-reading"):
        p = sub.add_parser(command)
        p.add_argument("--paper", required=True)
        if command == "read":
            p.add_argument("--pages")
            p.add_argument("--section")
            p.add_argument("--cursor", type=int, default=0)
            p.add_argument("--max-chars", type=int, default=16000)
        if command == "locate":
            p.add_argument("--block-id", required=True)
            p.add_argument("--text")
        if command == "save-reading":
            p.add_argument("--input", type=Path, required=True)
            p.add_argument("--agent", required=True)
    args = vars(parser.parse_args())
    command = args.pop("command")
    try:
        if command == "init-project":
            result = project_cache.init_project(**args)
        elif command == "list-papers":
            result = project_cache.list_papers(**args)
        elif command == "prepare":
            result = prepare(**args)
        else:
            paper = args.pop("paper")
            data = load_paper(paper)
            if command == "inspect":
                result = {k: v for k, v in data.items() if k != "pages"}
                result["page_summary"] = [{"page": p["page"], "blocks": len(p["blocks"]), "flags": p["flags"]} for p in data["pages"]]
                result["readings"] = [str(p) for p in sorted((Path(paper).parent / "readings").glob("*.json"))]
            elif command == "read":
                result = read_text(data, **args)
            elif command == "save-reading":
                reading = json.loads(args["input"].read_text(encoding="utf-8"))
                result = project_cache.save_reading(paper, data, reading, args["agent"])
            else:
                result = locate_block(data, **args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 2 if result.get("ok") is False else 0
    except (ValueError, OSError, KeyError, RuntimeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
