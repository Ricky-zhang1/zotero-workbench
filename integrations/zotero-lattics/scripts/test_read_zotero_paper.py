import json
import os
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys

import fitz
import read_zotero_paper as reader


class PaperReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.pdf = self.root / "paper.pdf"
        with fitz.open() as doc:
            for i in range(3):
                page = doc.new_page()
                if i < 2:
                    page.insert_text((60, 80), f"Section {i + 1}")
                    page.insert_text((60, 130), f"Evidence on physical page {i + 1} has a unique scope.")
            doc.set_toc([[1, "Introduction", 1], [1, "Results", 2]])
            doc.save(self.pdf)
        self.result = reader.prepare(self.pdf, "PARENT01", "PDF00001", cache_root=self.root / "cache")
        self.data = reader.load_paper(self.result["paper"])

    def test_cache_reused_and_markdown_contains_all_blocks(self):
        repeated = reader.prepare(self.pdf, "PARENT01", "PDF00001", cache_root=self.root / "cache")
        self.assertTrue(repeated["cache_hit"])
        md = Path(repeated["markdown"]).read_text()
        for page in self.data["pages"]:
            for block in page["blocks"]:
                self.assertIn(block["source_text"], md)

    def test_pagination_has_no_dropped_or_duplicate_blocks(self):
        ids, cursor = [], 0
        while True:
            batch = reader.read_text(self.data, cursor=cursor, max_chars=10)
            ids.extend(b["id"] for b in batch["blocks"])
            cursor = batch["next_cursor"]
            if cursor is None:
                break
        expected = [b["id"] for p in self.data["pages"] for b in p["blocks"]]
        self.assertEqual(ids, expected)

    def test_sections_keep_boundary_page(self):
        self.assertEqual(reader.read_text(self.data, section="s1")["selected_pages"], [1, 2])

    def test_sparse_page_is_visible(self):
        result = reader.read_text(self.data, pages="3")
        self.assertEqual(result["blocks"], [])
        self.assertTrue(any("Page 3" in w for w in result["warnings"]))

    def test_changed_bytes_with_same_size_and_mtime_are_rejected(self):
        stat = self.pdf.stat()
        original = self.pdf.read_bytes()
        changed = original[:-1] + bytes([original[-1] ^ 1])
        self.pdf.write_bytes(changed)
        os.utime(self.pdf, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        self.assertEqual(self.pdf.stat().st_size, stat.st_size)
        with self.assertRaises(ValueError):
            reader.load_paper(self.result["paper"])

    def test_exact_excerpt_uses_existing_locator(self):
        result = reader.locate_block(self.data, "p0002-b0002")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["page_index"], 1)
        self.assertIn("receipt_checksum", result)
        self.assertTrue(result["rects"])

    def test_rewritten_excerpt_rejected(self):
        with self.assertRaises(ValueError):
            reader.locate_block(self.data, "p0002-b0002", "Evidence proves everything.")

    def test_invalid_selections_and_identifiers(self):
        for args in ({"pages": "0"}, {"pages": "3-1"}, {"section": "s9"}, {"cursor": -1}):
            with self.assertRaises(ValueError):
                reader.read_text(self.data, **args)
        with self.assertRaises(ValueError):
            reader.prepare(self.pdf, "../bad", "PDF00001", cache_root=self.root)

    def test_damaged_markdown_is_rebuilt(self):
        Path(self.result["markdown"]).write_text("incomplete")
        result = reader.prepare(self.pdf, "PARENT01", "PDF00001", cache_root=self.root / "cache")
        self.assertFalse(result["cache_hit"])

    def test_cli_prepare_inspect_read_and_locate(self):
        def run(*args):
            output = subprocess.run([sys.executable, reader.__file__, *args],
                                    capture_output=True, text=True, check=True)
            return json.loads(output.stdout)
        prepared = run("prepare", "--pdf", str(self.pdf), "--item-key", "PARENT01",
                       "--attachment-key", "PDF00001", "--cache-root", str(self.root / "cli"))
        path = prepared["paper"]
        self.assertEqual(run("inspect", "--paper", path)["page_count"], 3)
        self.assertEqual(run("read", "--paper", path, "--pages", "2")["selected_pages"], [2])
        self.assertTrue(run("locate", "--paper", path, "--block-id", "p0002-b0002")["ok"])


if __name__ == "__main__":
    unittest.main()
