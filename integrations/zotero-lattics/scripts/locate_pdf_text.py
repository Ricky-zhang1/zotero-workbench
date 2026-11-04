#!/usr/bin/env python3
"""Locate an exact passage in one PDF and emit an atomic locator receipt.

This program never writes to Zotero. It accepts source text only, not a
paraphrase, and returns page, rectangles, a Zotero deep link, and a sort key.
The receipt also binds the result to the exact local PDF path, size, and
modification time so the Zotero plugin can reject stale or mixed results.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

import fitz


def normalise(text: str) -> str:
    # PDFs often encode compatibility glyphs such as circled digits (①) while
    # full-text extraction or a human transcript uses their plain equivalent
    # (1). NFKC is used only for coordinate-safe comparison; source_text in
    # the emitted receipt always remains the original PDF wording.
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"&(?:dquo|ldquo|rdquo);", '"', text, flags=re.IGNORECASE)
    text = re.sub(r"&(?:lsquo|rsquo);", "'", text, flags=re.IGNORECASE)
    text = re.sub(r"&(?:mdash|ndash);", "-", text, flags=re.IGNORECASE)
    text = re.sub(r"[\u00ad\u2010\u2011-]\s*\n\s*", "", text)
    text = text.translate(str.maketrans({
        "\u2014": "-", "\u2013": "-", "\u2012": "-",
        "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
        "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl",
        "\ufb03": "ffi", "\ufb04": "ffl",
    }))
    return re.sub(r"\s+", " ", text).strip()


def page_to_pdf_transform(page: fitz.Page) -> tuple[float, float, float, float, float, float]:
    a, b, c, d, e, f = page.transformation_matrix
    determinant = a * d - b * c
    return (d / determinant, -b / determinant, -c / determinant, a / determinant,
            (c * f - d * e) / determinant, (b * e - a * f) / determinant)


def zotero_rects(page: fitz.Page, rectangles: list[fitz.Rect]) -> tuple[list[list[float]], float, float]:
    a, b, c, d, e, f = page_to_pdf_transform(page)
    converted: list[list[float]] = []
    min_y = float("inf")
    min_x = float("inf")
    for rect in rectangles:
        x0, y0, x1, y1 = rect
        xs = (a * x0 + c * y0 + e, a * x1 + c * y1 + e)
        ys = (b * x0 + d * y0 + f, b * x1 + d * y1 + f)
        converted_rect = [round(min(xs), 3), round(min(ys), 3), round(max(xs), 3), round(max(ys), 3)]
        converted.append(converted_rect)
        min_y = min(min_y, converted_rect[1])
        min_x = min(min_x, converted_rect[0])
    return converted, min_y, min_x


def anchors(text: str) -> list[str]:
    words = text.split()
    if len(words) < 14:
        return []
    width = min(16, max(8, len(words) // 3))
    return [" ".join(words[:width]), " ".join(words[-width:])]


def infer_printed_page_labels(document: fitz.Document) -> dict[int, str]:
    """Infer a continuous journal page sequence from page-margin numbers."""
    candidates: list[set[int]] = []
    for page in document:
        values: set[int] = set()
        for word in page.get_text("words", sort=False):
            text = str(word[4]).strip()
            # str.isdigit() accepts compatibility glyphs such as ①, but
            # int("①") raises and these are usually footnote markers rather
            # than printed page labels. Page-label inference accepts only
            # ordinary ASCII margin numbers.
            if not re.fullmatch(r"[0-9]{1,4}", text):
                continue
            if float(word[1]) < 80 or float(word[3]) > page.rect.height - 80:
                values.add(int(text))
        candidates.append(values)

    base_scores: dict[int, int] = {}
    for index, values in enumerate(candidates):
        for value in values:
            base = value - index
            base_scores[base] = sum(
                1 for page_index, page_values in enumerate(candidates)
                if base + page_index in page_values
            )
    if not base_scores:
        return {}
    base, score = max(base_scores.items(), key=lambda item: item[1])
    minimum_score = min(3, len(document))
    if score < minimum_score or score / max(1, len(document)) < 0.4:
        return {}
    return {index: str(base + index) for index in range(len(document))}


def token_key(text: str) -> str:
    """Canonical token form used only for coordinate-safe word matching."""
    return normalise(text).casefold().replace("-", "")


def locator_checksum(receipt: dict) -> str:
    """Return a compact mutation detector shared with the Zotero plugin."""
    rects = ";".join(
        ",".join(f"{float(value):.3f}" for value in rect)
        for rect in receipt["rects"]
    )
    fields = [
        str(receipt["locator_receipt_version"]),
        str(receipt["attachment_key"]),
        str(receipt["page_index"]),
        str(receipt["page_label"]),
        str(receipt["source_text"]),
        str(receipt["pdf_path"]),
        str(receipt["pdf_size"]),
        str(receipt["pdf_mtime_ms"]),
        str(receipt["match_kind"]),
        str(receipt["sort_index"]),
        rects,
    ]
    framed = "|".join(f"{len(field)}:{field}" for field in fields)
    value = 2166136261
    for char in framed:
        value ^= ord(char)
        value = (value * 16777619) & 0xFFFFFFFF
    return f"fnv1a32:{value:08x}"


def word_sequence_matches(page: fitz.Page, source_text: str) -> list[list[fitz.Rect]]:
    """Find a passage as a contiguous PDF word sequence.

    PDF text layers commonly split one printed word at a line-ending hyphen.
    PyMuPDF's phrase search then fails even though every word has coordinates.
    This matcher joins those line fragments for comparison while retaining the
    physical word rectangles, then merges them back into one rectangle per line.
    """
    # Preserve the PDF content stream's block order. Geometric sorting can
    # interleave the left and right columns of journal pages line by line.
    raw_words = page.get_text("words", sort=False)
    logical_words: list[dict] = []
    index = 0
    while index < len(raw_words):
        word = raw_words[index]
        raw_text = normalise(str(word[4]))
        parts = [word]
        key = token_key(raw_text)
        if raw_text.endswith(("-", "\u00ad", "\u2010", "\u2011")) and index + 1 < len(raw_words):
            following = raw_words[index + 1]
            key += token_key(str(following[4]))
            parts.append(following)
            index += 1
        if key:
            logical_words.append({"key": key, "parts": parts})
        index += 1

    query = [token_key(token) for token in normalise(source_text).split()]
    query = [token for token in query if token]
    if not query or len(query) > len(logical_words):
        return []

    def rectangles_for(logical_slice: list[dict]) -> list[fitz.Rect]:
        physical_words = [
            part
            for logical in logical_slice
            for part in logical["parts"]
        ]
        lines: list[fitz.Rect] = []
        current_line: tuple[int, int] | None = None
        current_rect: fitz.Rect | None = None
        for part in physical_words:
            line_key = (int(part[5]), int(part[6]))
            rect = fitz.Rect(part[:4])
            if current_line == line_key and current_rect is not None:
                current_rect.include_rect(rect)
            else:
                if current_rect is not None:
                    lines.append(current_rect)
                current_line = line_key
                current_rect = rect
        if current_rect is not None:
            lines.append(current_rect)
        return lines

    matches: list[list[fitz.Rect]] = []
    # CJK PDF text layers commonly put an entire printed line in one "word"
    # while source passages contain no inserted spaces. Match consecutive PDF
    # word chunks as one canonical stream, but return every chunk's rectangles.
    if len(query) == 1:
        target = query[0]
        stream = ""
        spans: list[tuple[int, int]] = []
        for logical in logical_words:
            start = len(stream)
            stream += logical["key"]
            spans.append((start, len(stream)))

        match_start = stream.find(target)
        while match_start >= 0:
            match_end = match_start + len(target)
            selected = [
                index
                for index, (start, end) in enumerate(spans)
                if start < match_end and end > match_start
            ]
            if selected:
                first, last = selected[0], selected[-1]
                rectangles = rectangles_for(logical_words[first:last + 1])

                def replace_line(reference: fitz.Rect, replacement: fitz.Rect) -> bool:
                    for rect_index, rectangle in enumerate(rectangles):
                        if rectangle.intersects(reference):
                            rectangles[rect_index] = replacement
                            return True
                    return False

                precise = True
                if match_start > spans[first][0]:
                    first_fragment = target[:spans[first][1] - match_start]
                    first_hits = page.search_for(first_fragment)
                    first_reference = fitz.Rect(logical_words[first]["parts"][0][:4])
                    first_hit = next((hit for hit in first_hits if hit.intersects(first_reference)), None)
                    precise = bool(first_hit) and replace_line(first_reference, first_hit)

                if precise and last != first and match_end < spans[last][1]:
                    last_fragment = target[spans[last][0] - match_start:]
                    last_hits = page.search_for(last_fragment)
                    last_reference = fitz.Rect(logical_words[last]["parts"][0][:4])
                    last_hit = next((hit for hit in last_hits if hit.intersects(last_reference)), None)
                    precise = bool(last_hit) and replace_line(last_reference, last_hit)

                if precise:
                    matches.append(rectangles)
            match_start = stream.find(target, match_start + 1)
        return matches

    for start in range(len(logical_words) - len(query) + 1):
        if [word["key"] for word in logical_words[start:start + len(query)]] != query:
            continue
        matches.append(rectangles_for(logical_words[start:start + len(query)]))
    return matches


def match_on_page(page: fitz.Page, source_text: str) -> tuple[list[fitz.Rect], str, int] | None:
    word_matches = word_sequence_matches(page, source_text)
    if word_matches:
        direct = page.search_for(source_text)
        return word_matches[0], "exact" if direct else "normalised", len(word_matches)
    direct = page.search_for(source_text)
    if direct:
        return direct, "exact", 1
    collapsed = normalise(source_text)
    if collapsed != source_text:
        direct = page.search_for(collapsed)
        if direct:
            return direct, "normalised", 1
    anchor_hits: list[fitz.Rect] = []
    for anchor in anchors(collapsed):
        hits = page.search_for(anchor)
        if hits:
            anchor_hits.extend(hits)
    if len(anchor_hits) >= 2:
        return anchor_hits, "anchor", 0
    return None


def locate(pdf_path: Path, source_text: str, attachment_key: str, page: int | None) -> dict:
    pdf_path = pdf_path.resolve()
    if not pdf_path.is_file():
        return {"ok": False, "error": "pdf_not_found", "path": str(pdf_path)}
    if len(source_text.strip()) < 8:
        return {"ok": False, "error": "source_text_too_short", "hint": "Pass an exact source passage of at least 8 characters."}
    stat = pdf_path.stat()
    document = fitz.open(pdf_path)
    try:
        inferred_labels = infer_printed_page_labels(document)
        page_indices = [page - 1] if page else list(range(len(document)))
        page_indices = [index for index in page_indices if 0 <= index < len(document)]
        exact_matches: list[dict] = []
        anchor_matches: list[dict] = []
        for index in page_indices:
            pdf_page = document[index]
            found = match_on_page(pdf_page, source_text)
            if not found:
                continue
            rectangles, match_kind, occurrence_count = found
            rects, min_y, min_x = zotero_rects(pdf_page, rectangles)
            label = pdf_page.get_label() if hasattr(pdf_page, "get_label") else ""
            label = label or inferred_labels.get(index) or str(index + 1)
            match = {
                "match_kind": match_kind,
                "page_index": index,
                "page_label": label,
                "rects": rects,
                "sort_index": f"{index:05d}|{int(min_y):06d}|{int(min_x):05d}",
                "occurrence_count": occurrence_count,
                "zotero_url": f"zotero://open-pdf/library/items/{attachment_key}?page={index + 1}",
            }
            if match_kind in {"exact", "normalised"}:
                exact_matches.append(match)
            else:
                anchor_matches.append(match)

        repeated = [match for match in exact_matches if match["occurrence_count"] != 1]
        if len(exact_matches) > 1 or repeated:
            return {
                "ok": False,
                "error": "ambiguous_text_multiple_occurrences",
                "attachment_key": attachment_key,
                "candidate_pages": [match["page_index"] + 1 for match in exact_matches],
                "hint": "The passage occurs more than once. If candidates are on different pages, add --page after checking Zotero; if repeated on one page, pass a longer unique passage. Do not create a highlight yet.",
            }

        if len(exact_matches) == 1:
            match = exact_matches[0]
            receipt = {
                "ok": True,
                "locator_receipt_version": 1,
                "confidence": "high",
                "attachment_key": attachment_key,
                "source_text": source_text.strip(),
                "pdf_path": str(pdf_path),
                "pdf_size": stat.st_size,
                "pdf_mtime_ms": stat.st_mtime_ns // 1_000_000,
                **match,
            }
            receipt["receipt_checksum"] = locator_checksum(receipt)
            return receipt

        if anchor_matches:
            return {
                "ok": False,
                "error": "anchor_only_match",
                "confidence": "review_required",
                "attachment_key": attachment_key,
                "candidate_pages": [match["page_index"] + 1 for match in anchor_matches],
                "zotero_urls": [match["zotero_url"] for match in anchor_matches],
                "hint": "Only the beginning and end anchors matched. Open the candidate page and obtain one exact sentence; do not create a highlight from anchor coordinates.",
            }
        return {
            "ok": False,
            "error": "exact_text_not_found",
            "searched_pages": [index + 1 for index in page_indices],
            "hint": "Do not create a highlight. Re-read the candidate passage or use Zotero semantic/full-text search to obtain the exact PDF wording.",
        }
    finally:
        document.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", required=True, help="Local PDF path returned by Zotero.")
    parser.add_argument("--attachment-key", required=True, help="Zotero PDF attachment key.")
    parser.add_argument("--text", required=True, help="Exact source passage, not a paraphrase.")
    parser.add_argument("--page", type=int, help="Optional one-based candidate page to search first.")
    args = parser.parse_args()
    result = locate(Path(args.pdf).expanduser(), args.text, args.attachment_key, args.page)
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    raise SystemExit(main())
