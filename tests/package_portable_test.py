from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = SOURCE_ROOT / "scripts/package-portable.py"
SPEC = importlib.util.spec_from_file_location("package_portable", SCRIPT_PATH)
portable = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = portable
SPEC.loader.exec_module(portable)

TARGET = "darwin-arm64"
ARCHIVE_NAME = portable.NODE_RELEASES[TARGET]["archive"]
RUNTIME_MEMBER = portable.NODE_RELEASES[TARGET]["runtime_member"]
LICENSE_MEMBER = portable.NODE_RELEASES[TARGET]["license_member"]


def make_node_archive(runtime: bytes | None = None, include_runtime: bool = True) -> bytes:
    runtime = runtime if runtime is not None else b"fixture-node-runtime"
    archive_bytes = io.BytesIO()
    with tarfile.open(fileobj=archive_bytes, mode="w:gz") as archive:
        if include_runtime:
            info = tarfile.TarInfo(RUNTIME_MEMBER)
            info.mode = 0o755
            info.size = len(runtime)
            archive.addfile(info, io.BytesIO(runtime))
        license_data = b"Fixture Node.js license\n"
        info = tarfile.TarInfo(LICENSE_MEMBER)
        info.mode = 0o644
        info.size = len(license_data)
        archive.addfile(info, io.BytesIO(license_data))
    return archive_bytes.getvalue()


class FakeOfficialRelease:
    def __init__(self, archive: bytes, checksum_archive: bytes | None = None):
        self.archive = archive
        self.checksum_archive = checksum_archive if checksum_archive is not None else archive
        archive_hash = hashlib.sha256(self.checksum_archive).hexdigest()
        self.sums = f"{archive_hash}  {ARCHIVE_NAME}\n".encode("ascii")
        self.release_records = {
            TARGET: {
                **portable.NODE_RELEASES[TARGET],
                "sha256": archive_hash,
            }
        }

    def opener(self, request, timeout=0, context=None):
        url = request.full_url
        if url == portable.NODE_SHASUMS_URL:
            return io.BytesIO(self.sums)
        if url.endswith("/" + ARCHIVE_NAME):
            return io.BytesIO(self.archive)
        raise AssertionError(f"Unexpected download URL in offline fixture: {url}")


class PortablePackageTests(unittest.TestCase):
    def build_fixture(self, output_dir: Path, fake: FakeOfficialRelease, *, verify_native=False):
        return portable.build_package(
            root=SOURCE_ROOT,
            target=TARGET,
            output_dir=output_dir,
            opener=fake.opener,
            release_records=fake.release_records,
            verify_native=verify_native,
        )

    def package_members(self, package_path: Path):
        with zipfile.ZipFile(package_path) as archive:
            names = archive.namelist()
            root = names[0].split("/", 1)[0]
            return archive, root, set(names)

    def test_package_contains_runtime_and_optional_feature_sources(self):
        with tempfile.TemporaryDirectory() as temp:
            fake = FakeOfficialRelease(make_node_archive())
            result = self.build_fixture(Path(temp), fake)
            package = Path(result["package"])
            with zipfile.ZipFile(package) as archive:
                names = set(archive.namelist())
                root = next(name.split("/", 1)[0] for name in names if name.endswith("/src/server.mjs"))
                plugin = f"{root}/plugins/zotero-workbench"
                required = {
                    f"{plugin}/src/server.mjs",
                    f"{plugin}/dist/runtime.mjs",
                    f"{plugin}/dist/ui/panel.html",
                    f"{plugin}/assets/icon.png",
                    f"{plugin}/skills/zotero-workbench/SKILL.md",
                    f"{plugin}/integrations/zotero-lattics/scripts/citation_evidence_audit.py",
                    f"{plugin}/scripts/research-worker.py",
                    f"{plugin}/scripts/setup-research.py",
                    f"{plugin}/vendor/textfold/LICENSE",
                    f"{plugin}/vendor/textfold/NOTICE",
                    f"{plugin}/vendor/zcode-zotero-0.2.1/LICENSE",
                    f"{plugin}/vendor/zcode-zotero-0.2.1/dist/THIRD_PARTY_NOTICES.txt",
                    f"{plugin}/licenses/node/LICENSE",
                    f"{plugin}/licenses/node/SHASUMS256.txt",
                    f"{root}/.agents/plugins/marketplace.json",
                    f"{root}/PORTABLE-MANIFEST.json",
                }
                self.assertTrue(required.issubset(names), sorted(required - names))
                self.assertTrue(any(name.startswith(f"{plugin}/dist/pdfjs/") for name in names))
                self.assertFalse(any("/tests/" in name for name in names))
                self.assertFalse(any("/integrations/dsh/" in name for name in names))
                self.assertFalse(any("/.runtime/" in name for name in names))
                self.assertFalse(any("/testing/" in name or "/releases/" in name for name in names))
                self.assertFalse(any("fitz" in name.lower() or "pymupdf" in name.lower() for name in names))
                manifest = json.loads(archive.read(f"{root}/PORTABLE-MANIFEST.json"))
                self.assertEqual(manifest["node"]["version"], "24.22.2")
                self.assertEqual(manifest["channel"], "open-source-preview")
                self.assertFalse(manifest["commercialReleaseApproved"])
                for rel, expected in manifest["files"].items():
                    self.assertEqual(hashlib.sha256(archive.read(f"{root}/{rel}")).hexdigest(), expected, rel)
                marketplace = json.loads(archive.read(f"{root}/.agents/plugins/marketplace.json"))
                self.assertEqual(marketplace["plugins"][0]["source"]["path"], "./plugins/zotero-workbench")
                readme = archive.read(f"{root}/README-PORTABLE.md").decode("utf-8")
                self.assertIn("开源预览包", readme)
                self.assertIn("不需要单独运行 Zotero MCP 服务", readme)
                self.assertIn("依赖已运行的本机 Zotero MCP 服务", readme)
                self.assertIn("TextFold 全文任务仍需 Python 3", readme)
                self.assertIn("本基础包不包含 PyMuPDF", readme)

    def test_runtime_zip_mode_is_executable_and_configs_use_distinct_roots(self):
        with tempfile.TemporaryDirectory() as temp:
            fake = FakeOfficialRelease(make_node_archive())
            result = self.build_fixture(Path(temp), fake)
            with zipfile.ZipFile(result["package"]) as archive:
                root = next(name.split("/", 1)[0] for name in archive.namelist() if name.endswith("/src/server.mjs"))
                runtime_info = archive.getinfo(f"{root}/plugins/zotero-workbench/runtime/node")
                self.assertEqual((runtime_info.external_attr >> 16) & 0o777, 0o755)
                plugin_mcp = json.loads(archive.read(f"{root}/plugins/zotero-workbench/.mcp.json"))
                portable_mcp = json.loads(archive.read(f"{root}/plugins/zotero-workbench/mcp.json"))
                self.assertEqual(plugin_mcp["mcpServers"]["zotero-workbench"]["command"], "${CODEX_PLUGIN_ROOT}/runtime/node")
                self.assertEqual(plugin_mcp["mcpServers"]["zotero-workbench"]["args"], ["${CODEX_PLUGIN_ROOT}/src/server.mjs"])
                self.assertEqual(portable_mcp["mcpServers"]["zotero-workbench"]["command"], "${PLUGIN_ROOT}/runtime/node")
                self.assertEqual(portable_mcp["mcpServers"]["zotero-workbench"]["args"], ["${PLUGIN_ROOT}/src/server.mjs"])

    def test_package_has_no_private_machine_paths_or_local_install_config(self):
        with tempfile.TemporaryDirectory() as temp:
            fake = FakeOfficialRelease(make_node_archive())
            result = self.build_fixture(Path(temp), fake)
            with zipfile.ZipFile(result["package"]) as archive:
                names = archive.namelist()
                all_bytes = b"\n".join(archive.read(name) for name in names if not name.endswith("/"))
                for denied in (
                    str(Path.home()).encode(),
                    b"/Volumes/ExampleDrive/",
                    b"/Users/example/",
                ):
                    self.assertNotIn(denied, all_bytes)
                self.assertFalse(any(name.endswith("/.mcp.json") and "/plugins/zotero-workbench/" not in name for name in names))
                self.assertFalse(any("integrations/dsh/cordis.patch.yml" in name for name in names))

    @unittest.skipUnless(shutil.which("node"), "Node is required only as an isolated launch-test fixture")
    def test_clean_path_mcp_start_uses_packaged_runtime_and_reads_resources(self):
        # The temporary fixture carries a launcher that delegates to the host
        # Node binary. It exercises package-root resolution with an empty PATH;
        # it is discarded and never becomes a portable release runtime. The
        # separate real build verifies the pinned Node 24 archive.
        node_path = Path(shutil.which("node")).resolve()
        runtime_bytes = (
            "#!/bin/sh\nexec " + shlex.quote(str(node_path)) + " \"$@\"\n"
        ).encode("utf-8")
        with tempfile.TemporaryDirectory() as temp:
            fake = FakeOfficialRelease(make_node_archive(runtime_bytes))
            result = self.build_fixture(Path(temp) / "out", fake)
            unpacked = Path(temp) / "unpacked"
            with zipfile.ZipFile(result["package"]) as archive:
                archive.extractall(unpacked)
            root = next(unpacked.iterdir())
            plugin_root = root / "plugins/zotero-workbench"
            runtime = plugin_root / "runtime/node"
            runtime.chmod(0o755)
            home = Path(temp) / "clean home"
            home.mkdir()
            request_lines = [
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                    "protocolVersion": "2025-03-26", "capabilities": {},
                    "clientInfo": {"name": "portable-test", "version": "1"},
                }},
                {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
                {"jsonrpc": "2.0", "id": 3, "method": "resources/list", "params": {}},
                {"jsonrpc": "2.0", "id": 4, "method": "resources/read", "params": {"uri": "ui://zotero/panel.html"}},
            ]
            env = {
                "HOME": str(home),
                "TMPDIR": str(temp),
                "PATH": "",
                "ZOTERO_WORKBENCH_STATE_DIR": str(Path(temp) / "state"),
            }
            process = subprocess.Popen(
                [str(runtime), str(plugin_root / "src/server.mjs")],
                text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, env=env, cwd=plugin_root, bufsize=1,
            )

            def request_and_read(message, response_id):
                process.stdin.write(json.dumps(message) + "\n")
                process.stdin.flush()
                while True:
                    line = process.stdout.readline()
                    if line == "":
                        self.fail("MCP server exited before replying; " + process.stderr.read())
                    if not line.startswith("{"):
                        continue
                    reply = json.loads(line)
                    if reply.get("id") == response_id:
                        return reply

            try:
                by_id = {1: request_and_read(request_lines[0], 1)}
                process.stdin.write(json.dumps(request_lines[1]) + "\n")
                process.stdin.flush()
                by_id[2] = request_and_read(request_lines[2], 2)
                by_id[3] = request_and_read(request_lines[3], 3)
                by_id[4] = request_and_read(request_lines[4], 4)
            finally:
                process.stdin.close()
                process.stdout.read()
                stderr = process.stderr.read()
                returncode = process.wait(timeout=45)
                process.stdout.close()
                process.stderr.close()
            self.assertEqual(returncode, 0, stderr)
            self.assertNotIn("error", by_id[1])
            self.assertGreater(len(by_id[2]["result"]["tools"]), 0)
            resource_uris = {item["uri"] for item in by_id[3]["result"]["resources"]}
            self.assertIn("ui://zotero/panel.html", resource_uris)
            panel_html = by_id[4]["result"]["contents"][0]["text"]
            self.assertIn("<!doctype html>", panel_html[:100].lower())

    def test_missing_runtime_member_fails_before_writing_any_package(self):
        with tempfile.TemporaryDirectory() as temp:
            fake = FakeOfficialRelease(make_node_archive(include_runtime=False))
            output = Path(temp) / "portable-output"
            with self.assertRaisesRegex(ValueError, "missing a required runtime"):
                self.build_fixture(output, fake)
            self.assertFalse(output.exists())

    def test_corrupted_node_download_fails_checksum_and_leaves_no_partial_package(self):
        with tempfile.TemporaryDirectory() as temp:
            valid_archive = make_node_archive()
            fake = FakeOfficialRelease(valid_archive)
            original_opener = fake.opener

            def corrupted_opener(request, timeout=0, context=None):
                if request.full_url.endswith("/" + ARCHIVE_NAME):
                    return io.BytesIO(valid_archive + b"corruption")
                return original_opener(request, timeout, context)

            fake.opener = corrupted_opener
            output = Path(temp) / "portable-output"
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                portable.build_package(
                    root=SOURCE_ROOT,
                    target=TARGET,
                    output_dir=output,
                    opener=fake.opener,
                    release_records=fake.release_records,
                    verify_native=False,
                )
            self.assertFalse(output.exists())
            self.assertEqual(list(Path(temp).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
