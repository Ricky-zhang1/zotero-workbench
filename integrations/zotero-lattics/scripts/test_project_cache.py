from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import fitz
import project_cache as cache
import read_zotero_paper as reader


class ProjectCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.project = self.root / "研究甲"
        self.project.mkdir()
        self.pdf = self.root / "source.pdf"
        with fitz.open() as doc:
            page = doc.new_page()
            page.insert_text((50, 70), "A source sentence with a specific scope.")
            doc.save(self.pdf)

    def cli(self, *args):
        result = subprocess.run([sys.executable, reader.__file__, *map(str, args)],
                                capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    def prepare(self, project=None):
        return reader.prepare(self.pdf, "PARENT01", "PDF00001", project_root=project or self.project)

    def test_custom_location_and_nested_discovery(self):
        info = cache.init_project(self.project, "02_文献/Zotero阅读缓存")
        nested = self.project / "论文/工作稿"
        nested.mkdir(parents=True)
        self.assertEqual(cache.discover_project(nested), info)
        self.assertEqual(cache.resolve_cache(self.project), Path(info["papers_root"]))
        self.assertEqual(cache.init_project(self.project), info)

    def test_conflicting_location_and_escape_rejected(self):
        cache.init_project(self.project)
        with self.assertRaises(ValueError):
            cache.init_project(self.project, "another-cache")
        for relative in ("../outside", "/tmp/outside", "."):
            with self.assertRaises(ValueError):
                cache.project_path(self.project, relative)

    def test_no_silent_global_fallback(self):
        with patch.object(cache, "discover_project", return_value=None):
            with self.assertRaises(ValueError):
                cache.resolve_cache()
        self.assertEqual(cache.resolve_cache(standalone=True), reader.DEFAULT_CACHE)

    def test_project_isolation_and_move(self):
        cache.init_project(self.project)
        first = self.prepare()
        other = self.root / "研究乙"
        other.mkdir()
        cache.init_project(other)
        second = self.prepare(other)
        self.assertNotEqual(first["paper"], second["paper"])
        moved = self.root / "迁移后研究甲"
        shutil.move(str(self.project), moved)
        self.assertTrue(self.prepare(moved)["cache_hit"])
        self.assertEqual(len(cache.list_papers(moved)["papers"]), 1)

    def test_reading_notes_reused_without_overwrite(self):
        cache.init_project(self.project)
        result = self.prepare()
        data = reader.load_paper(result["paper"])
        note = {"summary": "The author discusses a scoped sentence.", "read_block_ids": ["p0001-b0001"]}
        a = cache.save_reading(result["paper"], data, note, "agent-a")
        b = cache.save_reading(result["paper"], data, note, "agent-b")
        self.assertNotEqual(a["reading"], b["reading"])
        self.assertEqual(json.loads(Path(a["reading"]).read_text())["status"], "ai_unverified")
        self.assertEqual(len(cache.list_papers(self.project)["papers"][0]["readings"]), 2)
        self.assertTrue(self.prepare()["cache_hit"])
        with self.assertRaises(ValueError):
            cache.save_reading(result["paper"], data, {**note, "read_block_ids": ["p0099-b0001"]}, "agent-a")

    def test_pdf_change_gets_separate_basis(self):
        cache.init_project(self.project)
        old = self.prepare()
        data = reader.load_paper(old["paper"])
        cache.save_reading(old["paper"], data, {"summary": "Prior reading", "read_block_ids": ["p0001-b0001"]}, "agent-a")
        with fitz.open(self.pdf) as doc:
            doc[0].insert_text((50, 110), "Additional evidence changes the document.")
            doc.saveIncr()
        new = self.prepare()
        self.assertNotEqual(old["paper"], new["paper"])
        self.assertFalse((Path(new["paper"]).parent / "readings").exists())
        with self.assertRaises(ValueError):
            reader.load_paper(old["paper"])

    def test_two_processes_prepare_and_share_cli_notes(self):
        def worker(_):
            self.cli("init-project", "--project-root", self.project)
            return self.cli("prepare", "--pdf", self.pdf, "--item-key", "PARENT01",
                            "--attachment-key", "PDF00001", "--project-root", self.project)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(worker, range(2)))
        self.assertEqual(results[0]["paper"], results[1]["paper"])
        paper = results[0]["paper"]
        payload = self.root / "note.json"
        payload.write_text(json.dumps({"summary": "Scoped source", "read_block_ids": ["p0001-b0001"]}))
        self.cli("save-reading", "--paper", paper, "--input", payload, "--agent", "agent-a")
        listed = self.cli("list-papers", "--project-root", self.project)
        self.assertEqual(len(listed["papers"][0]["readings"]), 1)
        self.assertEqual(len(self.cli("inspect", "--paper", paper)["readings"]), 1)


if __name__ == "__main__":
    unittest.main()
