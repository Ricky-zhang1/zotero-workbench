#!/usr/bin/env python3
"""Safely attach and inspect precise Zotero backlinks in Markdown drafts."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit


MARKDOWN_LINK_RE = re.compile(r"(?<!!)\[([^\]\n]+)\]\(([^)\s]+)\)")
INLINE_CODE_RE = re.compile(r"(`+)([^\n]*?)\1")
ITEM_KEY_RE = re.compile(r"^[A-Z0-9]{8}$", re.IGNORECASE)


def emit(payload: dict[str, Any], code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return code


def parse_zotero_url(url: str) -> dict[str, Any]:
    parts = urlsplit(url)
    path_parts = [part for part in parts.path.split("/") if part]
    if parts.scheme != "zotero" or parts.netloc != "open-pdf":
        raise ValueError("URL 必须使用 zotero://open-pdf/ 协议")

    library: str
    attachment_key: str
    if len(path_parts) == 3 and path_parts[:2] == ["library", "items"]:
        library = "library"
        attachment_key = path_parts[2]
    elif (
        len(path_parts) == 4
        and path_parts[0] == "groups"
        and path_parts[1].isdigit()
        and path_parts[2] == "items"
    ):
        library = f"groups/{path_parts[1]}"
        attachment_key = path_parts[3]
    else:
        raise ValueError("URL 路径必须指向 Zotero library 或 group PDF 附件")

    if not ITEM_KEY_RE.fullmatch(attachment_key):
        raise ValueError("PDF 附件 key 必须是 8 位 Zotero key")

    query = parse_qs(parts.query, keep_blank_values=True)
    page_values = query.get("page", [])
    annotation_values = query.get("annotation", [])
    if len(page_values) != 1 or not page_values[0].isdigit() or int(page_values[0]) < 1:
        raise ValueError("精确回链必须包含正整数 page")
    if (
        len(annotation_values) != 1
        or not ITEM_KEY_RE.fullmatch(annotation_values[0])
    ):
        raise ValueError("精确回链必须包含 8 位 annotation key")

    return {
        "library": library,
        "attachment_key": attachment_key.upper(),
        "page": int(page_values[0]),
        "annotation_key": annotation_values[0].upper(),
    }


def fenced_code_ranges(content: str) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    offset = 0
    start: int | None = None
    marker: str | None = None
    for line in content.splitlines(keepends=True):
        match = re.match(r"^[ \t]{0,3}(`{3,}|~{3,})", line)
        if match:
            current = match.group(1)
            if start is None:
                start = offset
                marker = current[0]
            elif current[0] == marker:
                ranges.append((start, offset + len(line)))
                start = None
                marker = None
        offset += len(line)
    if start is not None:
        ranges.append((start, len(content)))
    return ranges


def inside(position: int, ranges: list[tuple[int, int]]) -> bool:
    return any(start <= position < end for start, end in ranges)


def protected_ranges(content: str) -> tuple[list[tuple[int, int]], list[re.Match[str]]]:
    code_ranges = fenced_code_ranges(content)
    for match in INLINE_CODE_RE.finditer(content):
        if not inside(match.start(), code_ranges):
            code_ranges.append(match.span())

    prose_links = [
        match
        for match in MARKDOWN_LINK_RE.finditer(content)
        if not inside(match.start(), code_ranges)
    ]
    ranges = code_ranges + [match.span() for match in prose_links]
    return ranges, prose_links


def line_and_column(content: str, position: int) -> tuple[int, int]:
    line = content.count("\n", 0, position) + 1
    previous_newline = content.rfind("\n", 0, position)
    return line, position - previous_newline


def write_atomic(path: Path, content: str) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            handle.write(content)
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def attach(args: argparse.Namespace) -> int:
    path = Path(args.file).expanduser().resolve()
    if not path.is_file():
        return emit({"ok": False, "error": "file_not_found", "file": str(path)}, 2)
    if not args.text:
        return emit({"ok": False, "error": "empty_text"}, 2)
    try:
        parsed_url = parse_zotero_url(args.url)
    except ValueError as error:
        return emit(
            {
                "ok": False,
                "error": "invalid_zotero_url",
                "message": str(error),
            },
            2,
        )

    content = path.read_text(encoding="utf-8")
    ranges, prose_links = protected_ranges(content)
    matching_links = [match for match in prose_links if match.group(1) == args.text]
    if matching_links:
        same = [match for match in matching_links if match.group(2) == args.url]
        if len(matching_links) == 1 and len(same) == 1:
            line, column = line_and_column(content, same[0].start())
            return emit(
                {
                    "ok": True,
                    "status": "already_linked",
                    "changed": False,
                    "file": str(path),
                    "line": line,
                    "column": column,
                    **parsed_url,
                }
            )
        return emit(
            {
                "ok": False,
                "error": "citation_already_has_link",
                "message": "引用文字已位于其他 Markdown 链接中，未自动覆盖",
                "count": len(matching_links),
            },
            2,
        )

    positions = [
        match.start()
        for match in re.finditer(re.escape(args.text), content)
        if not inside(match.start(), ranges)
    ]
    if not positions:
        return emit(
            {
                "ok": False,
                "error": "text_not_found",
                "message": "正文中没有找到未链接的目标文字",
            },
            2,
        )
    if len(positions) > 1 and args.occurrence is None:
        return emit(
            {
                "ok": False,
                "error": "ambiguous_text",
                "message": "目标文字在正文中出现多次，请用 --occurrence 指定序号",
                "count": len(positions),
                "locations": [
                    {"line": line_and_column(content, position)[0], "column": line_and_column(content, position)[1]}
                    for position in positions
                ],
            },
            2,
        )

    occurrence = args.occurrence or 1
    if occurrence < 1 or occurrence > len(positions):
        return emit(
            {
                "ok": False,
                "error": "occurrence_out_of_range",
                "count": len(positions),
            },
            2,
        )
    position = positions[occurrence - 1]
    replacement = f"[{args.text}]({args.url})"
    updated = content[:position] + replacement + content[position + len(args.text) :]
    line, column = line_and_column(content, position)

    status = "written" if args.write else "preview"
    if args.write:
        write_atomic(path, updated)
    payload: dict[str, Any] = {
        "ok": True,
        "status": status,
        "changed": True,
        "file": str(path),
        "line": line,
        "column": column,
        "visible_text": args.text,
        "markdown": replacement,
        **parsed_url,
    }
    if not args.write:
        payload["message"] = "预演完成；加 --write 后才会修改文件"
    return emit(payload)


def scan(args: argparse.Namespace) -> int:
    path = Path(args.file).expanduser().resolve()
    if not path.is_file():
        return emit({"ok": False, "error": "file_not_found", "file": str(path)}, 2)
    content = path.read_text(encoding="utf-8")
    _, prose_links = protected_ranges(content)
    links: list[dict[str, Any]] = []
    for match in prose_links:
        url = match.group(2)
        if not url.startswith("zotero://open-pdf/"):
            continue
        line, column = line_and_column(content, match.start())
        entry: dict[str, Any] = {
            "text": match.group(1),
            "url": url,
            "line": line,
            "column": column,
        }
        try:
            entry.update(parse_zotero_url(url))
            entry["valid"] = True
        except ValueError as error:
            entry["valid"] = False
            entry["error"] = str(error)
        links.append(entry)
    invalid_count = sum(not link["valid"] for link in links)
    return emit(
        {
            "ok": invalid_count == 0,
            "file": str(path),
            "count": len(links),
            "invalid_count": invalid_count,
            "links": links,
        },
        0 if invalid_count == 0 else 2,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="在 Markdown 引用文字上安全附加或检查 Zotero 精确回链"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    attach_parser = subparsers.add_parser("attach", help="为唯一的引用文字附加回链")
    attach_parser.add_argument("file", help="Markdown 文件路径")
    attach_parser.add_argument("--text", required=True, help="正文中原样出现的引用文字")
    attach_parser.add_argument("--url", required=True, help="含 page 与 annotation 的 Zotero URL")
    attach_parser.add_argument("--occurrence", type=int, help="文字多次出现时指定第几处，从 1 开始")
    attach_parser.add_argument("--write", action="store_true", help="确认写入；默认只预演")
    attach_parser.set_defaults(handler=attach)

    scan_parser = subparsers.add_parser("scan", help="扫描并验证文件中的 Zotero 回链")
    scan_parser.add_argument("file", help="Markdown 文件路径")
    scan_parser.set_defaults(handler=scan)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())
