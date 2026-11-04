#!/usr/bin/env python3
"""Build a self-contained open-source preview Codex marketplace package with pinned Node 24."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import platform
import ssl
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN_NAME = "zotero-workbench"
PLUGIN_DIR = f"plugins/{PLUGIN_NAME}"
NODE_VERSION = "24.22.2"
NODE_RELEASE_BASE = f"https://nodejs.org/dist/v{NODE_VERSION}"
NODE_SHASUMS_URL = f"{NODE_RELEASE_BASE}/SHASUMS256.txt"

# SHA-256 values are copied from the official Node.js v24.22.2 SHASUMS256.txt.
# Each target is buildable; only the current host target is executed by this script.
NODE_RELEASES = {
    "darwin-arm64": {
        "archive": "node-v24.22.2-darwin-arm64.tar.gz",
        "sha256": "aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a",
        "runtime_member": "node-v24.22.2-darwin-arm64/bin/node",
        "license_member": "node-v24.22.2-darwin-arm64/LICENSE",
        "kind": "tar.gz",
        "runtime_path": "runtime/node",
        "runtime_mode": 0o755,
    },
    "darwin-x64": {
        "archive": "node-v24.22.2-darwin-x64.tar.gz",
        "sha256": "d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52",
        "runtime_member": "node-v24.22.2-darwin-x64/bin/node",
        "license_member": "node-v24.22.2-darwin-x64/LICENSE",
        "kind": "tar.gz",
        "runtime_path": "runtime/node",
        "runtime_mode": 0o755,
    },
    "win-x64": {
        "archive": "node-v24.22.2-win-x64.zip",
        "sha256": "ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2",
        "runtime_member": "node-v24.22.2-win-x64/node.exe",
        "license_member": "node-v24.22.2-win-x64/LICENSE",
        "kind": "zip",
        "runtime_path": "runtime/node.exe",
        "runtime_mode": 0o644,
    },
    "linux-x64": {
        "archive": "node-v24.22.2-linux-x64.tar.xz",
        "sha256": "48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75",
        "runtime_member": "node-v24.22.2-linux-x64/bin/node",
        "license_member": "node-v24.22.2-linux-x64/LICENSE",
        "kind": "tar.xz",
        "runtime_path": "runtime/node",
        "runtime_mode": 0o755,
    },
}

TEXTFOLD_REQUIRED_FILES = {
    "LICENSE", "NOTICE", "FORMAT.md", "UPSTREAM.json",
    "requirements-lock.txt", "SHA256SUMS.json",
}
NODE_LICENSE_PATH = "licenses/node/LICENSE"
NODE_SHASUMS_PATH = "licenses/node/SHASUMS256.txt"
MAX_ARCHIVE_BYTES = 150 * 1024 * 1024
MAX_CHECKSUM_BYTES = 1024 * 1024


def host_target() -> str | None:
    system = platform.system().lower()
    machine = platform.machine().lower()
    aliases = {"aarch64": "arm64", "amd64": "x64", "x86_64": "x64"}
    arch = aliases.get(machine, machine)
    if system == "darwin" and arch in {"arm64", "x64"}:
        return f"darwin-{arch}"
    if system == "windows" and arch == "x64":
        return "win-x64"
    if system == "linux" and arch == "x64":
        return "linux-x64"
    return None


def _download(url: str, opener=None, limit: int = MAX_ARCHIVE_BYTES, ca_bundle: Path | None = None) -> bytes:
    opener = opener or urllib.request.urlopen
    request = urllib.request.Request(url, headers={"User-Agent": "Zotero-Workbench-Private-Builder"})
    context = ssl.create_default_context(cafile=str(ca_bundle) if ca_bundle else None)
    with opener(request, timeout=90, context=context) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"Downloaded asset exceeds the {limit}-byte limit: {url}")
    if not data:
        raise ValueError(f"Downloaded asset is empty: {url}")
    return data


def checksum_for_asset(checksums: bytes, filename: str) -> str:
    try:
        text = checksums.decode("ascii")
    except UnicodeDecodeError as error:
        raise ValueError("Official Node checksum file is not ASCII.") from error
    matches = re.findall(rf"^([a-fA-F0-9]{{64}})\s+\*?{re.escape(filename)}\s*$", text, re.MULTILINE)
    if len(matches) != 1:
        raise ValueError(f"Official checksum file must contain exactly one entry for {filename}.")
    return matches[0].lower()


def extract_node_archive(archive_data: bytes, release: dict) -> tuple[bytes, bytes]:
    runtime_member = release["runtime_member"]
    license_member = release["license_member"]
    try:
        if release["kind"] == "zip":
            with zipfile.ZipFile(io.BytesIO(archive_data)) as archive:
                runtime_info = archive.getinfo(runtime_member)
                license_info = archive.getinfo(license_member)
                if runtime_info.is_dir() or license_info.is_dir():
                    raise ValueError("Node runtime or license entry is a directory.")
                runtime = archive.read(runtime_info)
                license_text = archive.read(license_info)
        else:
            tar_mode = {"tar.xz": "r:xz", "tar.gz": "r:gz"}.get(release["kind"])
            if tar_mode is None:
                raise ValueError(f"Unsupported Node tar archive type: {release['kind']}")
            with tarfile.open(fileobj=io.BytesIO(archive_data), mode=tar_mode) as archive:
                runtime_info = archive.getmember(runtime_member)
                license_info = archive.getmember(license_member)
                if not runtime_info.isfile() or not license_info.isfile():
                    raise ValueError("Node runtime or license entry is not a regular file.")
                runtime_file = archive.extractfile(runtime_info)
                license_file = archive.extractfile(license_info)
                if runtime_file is None or license_file is None:
                    raise ValueError("Node runtime or license entry is unreadable.")
                runtime = runtime_file.read()
                license_text = license_file.read()
    except (KeyError, tarfile.TarError, zipfile.BadZipFile, OSError) as error:
        raise ValueError(f"Official Node archive is missing a required runtime or license file: {error}") from error
    if not runtime or not license_text:
        raise ValueError("Official Node archive has an empty runtime or license file.")
    return runtime, license_text


def obtain_runtime(
    target: str,
    opener=None,
    release_records: dict | None = None,
    ca_bundle: Path | None = None,
    node_archive_path: Path | None = None,
    shasums_path: Path | None = None,
) -> tuple[bytes, bytes, bytes, dict]:
    records = NODE_RELEASES if release_records is None else release_records
    if target not in records:
        raise ValueError(f"Unsupported target {target!r}; supported build targets: {', '.join(records)}")
    release = records[target]
    sums = (
        Path(shasums_path).read_bytes() if shasums_path else
        _download(NODE_SHASUMS_URL, opener=opener, limit=MAX_CHECKSUM_BYTES, ca_bundle=ca_bundle)
    )
    if len(sums) > MAX_CHECKSUM_BYTES:
        raise ValueError("Official Node checksum file exceeds the size limit.")
    official_sum = checksum_for_asset(sums, release["archive"])
    pinned_sum = release["sha256"].lower()
    if official_sum != pinned_sum:
        raise ValueError(
            f"Official Node checksum entry changed for {release['archive']}; "
            "review the pinned release before packaging."
        )
    archive_url = f"{NODE_RELEASE_BASE}/{release['archive']}"
    archive_data = (
        Path(node_archive_path).read_bytes() if node_archive_path else
        _download(archive_url, opener=opener, ca_bundle=ca_bundle)
    )
    if len(archive_data) > MAX_ARCHIVE_BYTES:
        raise ValueError("Node archive exceeds the size limit.")
    actual_sum = hashlib.sha256(archive_data).hexdigest()
    if actual_sum != pinned_sum:
        raise ValueError(f"Node download SHA-256 mismatch for {release['archive']}; package not written.")
    runtime, license_text = extract_node_archive(archive_data, release)
    return runtime, license_text, sums, release


def _walk_files(directory: Path):
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        if "__pycache__" in path.parts or path.suffix == ".pyc" or path.name == ".DS_Store":
            continue
        yield path


def add_tree(files: dict[str, tuple[bytes, int]], root: Path, relative: str, predicate=None) -> None:
    source = root / relative
    if not source.is_dir():
        raise ValueError(f"Required portable runtime directory is missing: {relative}")
    for path in _walk_files(source):
        rel = path.relative_to(root).as_posix()
        if predicate is not None and not predicate(rel, path):
            continue
        files[f"{PLUGIN_DIR}/{rel}"] = (path.read_bytes(), 0o644)


def required_textfold_files(root: Path) -> list[Path]:
    directory = root / "vendor/textfold"
    if not directory.is_dir():
        raise ValueError("TextFold source is required to preserve the optional research feature.")
    found = []
    for path in _walk_files(directory):
        rel = path.relative_to(directory).as_posix()
        if path.suffix == ".py" or ("/" not in rel and path.name in TEXTFOLD_REQUIRED_FILES):
            found.append(path)
    names = {path.relative_to(directory).as_posix() for path in found}
    missing = sorted(TEXTFOLD_REQUIRED_FILES - names)
    if missing:
        raise ValueError("TextFold optional-feature files are missing: " + ", ".join(missing))
    return found


def collect_plugin_files(root: Path, target: str, runtime: bytes, node_license: bytes, node_checksums: bytes) -> dict[str, tuple[bytes, int]]:
    files: dict[str, tuple[bytes, int]] = {}
    add_tree(files, root, "src")
    add_tree(files, root, "dist")
    add_tree(files, root, "skills/zotero-workbench")

    # Retain Zotero-Lattics scripts referenced by the optional review skill and
    # runtime. Do not ship their test fixtures or private audit materials.
    add_tree(
        files, root, "integrations/zotero-lattics",
        predicate=lambda rel, path: (
            path.suffix != ".py" or not path.name.startswith("test_")
        ) and "__pycache__" not in path.parts,
    )

    for path in required_textfold_files(root):
        files[f"{PLUGIN_DIR}/{path.relative_to(root).as_posix()}"] = (path.read_bytes(), 0o644)

    for relative in (
        "scripts/research-worker.py", "scripts/setup-research.py",
        "vendor/zcode-zotero-0.2.1/LICENSE",
        "vendor/zcode-zotero-0.2.1/dist/THIRD_PARTY_NOTICES.txt",
        "assets/icon.png", "package.json", "plugin.json", ".codex-plugin/plugin.json",
        "LICENSE",
    ):
        path = root / relative
        if not path.is_file():
            raise ValueError(f"Required portable package file is missing: {relative}")
        files[f"{PLUGIN_DIR}/{relative}"] = (path.read_bytes(), 0o644)

    release = NODE_RELEASES[target]
    files[f"{PLUGIN_DIR}/{release['runtime_path']}"] = (runtime, release["runtime_mode"])
    files[f"{PLUGIN_DIR}/{NODE_LICENSE_PATH}"] = (node_license, 0o644)
    files[f"{PLUGIN_DIR}/{NODE_SHASUMS_PATH}"] = (node_checksums, 0o644)
    files[f"{PLUGIN_DIR}/.mcp.json"] = ((
        json.dumps({"mcpServers": {PLUGIN_NAME: {
            "command": "${CODEX_PLUGIN_ROOT}/" + release["runtime_path"],
            "args": ["${CODEX_PLUGIN_ROOT}/src/server.mjs"],
            "env": {
                "ZOTERO_URL": "http://127.0.0.1:23119",
                "ZOTERO_MCP_URL": "http://127.0.0.1:23120/mcp",
            },
        }}}, ensure_ascii=False, indent=2) + "\n"
    ).encode("utf-8"), 0o644)
    files[f"{PLUGIN_DIR}/mcp.json"] = ((
        json.dumps({"$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
                    "mcpServers": {PLUGIN_NAME: {
                        "type": "stdio",
                        "command": "${PLUGIN_ROOT}/" + release["runtime_path"],
                        "args": ["${PLUGIN_ROOT}/src/server.mjs"],
                        "env": {
                            "ZOTERO_URL": "http://127.0.0.1:23119",
                            "ZOTERO_MCP_URL": "http://127.0.0.1:23120/mcp",
                        },
                    }}}, ensure_ascii=False, indent=2) + "\n"
    ).encode("utf-8"), 0o644)
    return files


def package_readme(package_version: str, target: str) -> bytes:
    target_notes = {
        "darwin-arm64": "Built for macOS arm64. This is the first real-runtime target in this open-source preview.",
        "darwin-x64": "Build target for macOS x64; the package builder does not claim a real-host acceptance for this target.",
        "win-x64": "Build target for Windows x64; the package builder does not claim a real-host acceptance for this target.",
        "linux-x64": "Build target for Linux x64; the package builder does not claim a real-host acceptance for this target.",
    }[target]
    text = f"""# Zotero 文献工作台便携包

版本：{package_version}
平台目标：{target}
内置 Node.js：v{NODE_VERSION}

{target_notes}

## 安装

1. 将 ZIP 解压到一个会长期保留的位置，不要只移动其中的插件子文件夹。
2. 在 Codex 支持的“添加本地 marketplace”入口中，选择解压后的便携包根目录（其中包含 `.agents/plugins/marketplace.json`）。
3. 在该 marketplace 中安装并启用“Zotero 文献工作台”。本包不要求手工编辑 Codex 全局配置，也不提供 ZIP 双击直装。

如果当前 Codex 版本没有受支持的本地 marketplace 安装入口，请不要手改配置文件；此便携 ZIP 不提供替代安装器。

## Zotero 连接与能力

Zotero 必须运行并开放本机 API（`127.0.0.1:23119`）。文库浏览、PDF 阅读和读取已有批注走这个接口。普通高亮写入需要 Zotero 10；写入仍由用户明确操作并按工作台流程确认。

以下能力需满足相应条件，便携包不会暗中安装依赖或替用户授权：

- 笔记、元数据修改和 DOI/arXiv 导入通过 Zotero 本地 API 完成，不需要单独运行 Zotero MCP 服务；这些写入仍须先预览并由用户明确确认。
- AI 证据高亮和语义检索依赖已运行的本机 Zotero MCP 服务（`127.0.0.1:23120`）。服务不可用时，相应能力不可用。
- 研究者选定材料后，可由当前 Codex Agent 处理协作写作。TextFold 全文任务仍需 Python 3、运行 `scripts/setup-research.py` 建立 TextFold 环境，以及可用的 Codex CLI；这些属于可选研究功能。
- 引用审计脚本使用 Python 3。PDF 精确定位辅助脚本另需 PyMuPDF；本基础包不包含 PyMuPDF。

点击提问或启动研究任务会按对应功能把用户选定材料交给当前 Codex 模型，消耗该模型额度。安装本包不会自动发送文献内容。

## 包内容与状态

便携包包含工作台源码、已构建界面、技能、运行必需资源、可选研究源码以及 Node.js 官方许可和校验信息。它不含用户文库、研究缓存、验收记录、回退配置或 DSH 本机插件配置。

这是开源预览包，不代表商业分发批准。`PORTABLE-MANIFEST.json` 记录文件散列、平台目标及 Node.js 来源；同目录 `.sha256` 校验整个 ZIP。
"""
    return text.encode("utf-8")


def validate_no_private_paths(files: dict[str, tuple[bytes, int]], home: Path | None = None) -> None:
    denied = [
        # Homebrew's /opt/homebrew is a generic upstream runtime search path,
        # not a user-specific location. Reject this machine's actual home and
        # other known private roots instead.
        b"/Users/example/", b"/Volumes/ExampleDrive/",
    ]
    if home is not None:
        home_text = str(home).rstrip("/").encode("utf-8")
        if home_text:
            denied.append(home_text)
    for name, (data, _) in files.items():
        normalized = name.replace("\\", "/")
        if normalized.startswith("integrations/dsh/") or "integrations/dsh/" in normalized:
            raise ValueError("Local DSH files must not be included in a portable package.")
        for token in denied:
            if token and token in data:
                raise ValueError(f"Private machine path found in portable package file: {name}")


def validate_source_configuration(files: dict[str, tuple[bytes, int]], target: str) -> None:
    release = NODE_RELEASES[target]
    for relative, env_var in ((".mcp.json", "CODEX_PLUGIN_ROOT"), ("mcp.json", "PLUGIN_ROOT")):
        name = f"{PLUGIN_DIR}/{relative}"
        if name not in files:
            raise ValueError(f"Generated portable MCP config is missing: {name}")
        data = json.loads(files[name][0])
        server = data["mcpServers"][PLUGIN_NAME]
        expected_command = "${" + env_var + "}/" + release["runtime_path"]
        expected_root = "${" + env_var + "}/src/server.mjs"
        if server.get("command") != expected_command or server.get("args") != [expected_root]:
            raise ValueError(f"Portable MCP paths are invalid in {name}.")


def verify_native_runtime(runtime_path: Path, target: str, version: str = NODE_VERSION) -> None:
    if target != host_target():
        return
    try:
        result = subprocess.run(
            [str(runtime_path), "--version"], check=True, capture_output=True,
            text=True, timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError(f"Downloaded Node runtime failed its native startup check: {error}") from error
    if result.stdout.strip() != f"v{version}":
        raise ValueError(f"Node runtime reported {result.stdout.strip()!r}, expected v{version}.")


def _write_zip(path: Path, package_root: str, files: dict[str, tuple[bytes, int]]) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for relative, (data, mode) in sorted(files.items()):
            info = zipfile.ZipInfo(f"{package_root}/{relative}", date_time=(2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (stat.S_IFREG | mode) << 16
            archive.writestr(info, data)


def build_package(
    root: Path = ROOT,
    target: str = "darwin-arm64",
    output_dir: Path | None = None,
    opener=None,
    release_records: dict | None = None,
    verify_native: bool = True,
    ca_bundle: Path | None = None,
    node_archive_path: Path | None = None,
    shasums_path: Path | None = None,
) -> dict:
    root = Path(root).resolve()
    if target not in NODE_RELEASES:
        raise ValueError(f"Unsupported target {target!r}; supported build targets: {', '.join(NODE_RELEASES)}")
    package_version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
    runtime, node_license, checksums, release = obtain_runtime(
        target, opener, release_records, ca_bundle, node_archive_path, shasums_path
    )
    files = collect_plugin_files(root, target, runtime, node_license, checksums)
    files["README-PORTABLE.md"] = (package_readme(package_version, target), 0o644)

    marketplace = {
        "name": f"{PLUGIN_NAME}-portable",
        "plugins": [{
            "name": PLUGIN_NAME,
            "source": {"source": "local", "path": "./plugins/zotero-workbench"},
            "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
            "category": "Research",
            "description": "Zotero library, PDF reading, citations and human–Agent collaboration.",
        }],
    }
    files[".agents/plugins/marketplace.json"] = (
        (json.dumps(marketplace, ensure_ascii=False, indent=2) + "\n").encode("utf-8"), 0o644
    )

    validate_no_private_paths(files, Path.home())
    validate_source_configuration(files, target)
    runtime_path = None
    if verify_native and target == host_target():
        runtime_fd, runtime_name = tempfile.mkstemp(prefix="zotero-workbench-node-")
        os.close(runtime_fd)
        runtime_path = Path(runtime_name)
        try:
            runtime_path.write_bytes(runtime)
            runtime_path.chmod(0o755)
            verify_native_runtime(runtime_path, target)
        finally:
            runtime_path.unlink(missing_ok=True)

    output_dir = Path(output_dir or (root / "releases/portable")).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    package_root = f"zotero-workbench-portable-{package_version}-{target}"
    artifact_name = f"{package_root}-node-v{NODE_VERSION}.zip"
    output_path = output_dir / artifact_name
    checksum_path = output_path.with_suffix(output_path.suffix + ".sha256")
    if output_path.exists() or checksum_path.exists():
        raise FileExistsError(f"Portable package already exists; refusing to overwrite: {output_path}")

    manifest = {
        "name": PLUGIN_NAME,
        "version": package_version,
        "channel": "open-source-preview",
        "commercialReleaseApproved": False,
        "target": target,
        "buildTargets": sorted(NODE_RELEASES),
        "node": {
            "version": NODE_VERSION,
            "archive": release["archive"],
            "officialShasumsUrl": NODE_SHASUMS_URL,
            "archiveSha256": release["sha256"],
            "runtimePath": release["runtime_path"],
            "runtimeSha256": hashlib.sha256(runtime).hexdigest(),
        },
        "hostRuntimeVersionChecked": bool(verify_native and target == host_target()),
        "files": {name: hashlib.sha256(data).hexdigest() for name, (data, _) in sorted(files.items())},
    }
    files["PORTABLE-MANIFEST.json"] = ((json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8"), 0o644)

    temp_zip = None
    temp_sum = None
    try:
        with tempfile.NamedTemporaryFile(prefix=f".{artifact_name}.", suffix=".tmp", dir=output_dir, delete=False) as handle:
            temp_zip = Path(handle.name)
        _write_zip(temp_zip, package_root, files)
        with zipfile.ZipFile(temp_zip, "r") as archive:
            bad = archive.testzip()
            if bad is not None:
                raise ValueError(f"Portable ZIP integrity check failed at {bad}.")
            runtime_info = archive.getinfo(f"{package_root}/{PLUGIN_DIR}/{release['runtime_path']}")
            runtime_mode = (runtime_info.external_attr >> 16) & 0o777
            if runtime_mode != release["runtime_mode"]:
                raise ValueError(f"Runtime ZIP permissions are {oct(runtime_mode)}, expected {oct(release['runtime_mode'])}.")
        zip_sha = hashlib.sha256(temp_zip.read_bytes()).hexdigest()
        checksum_content = f"{zip_sha}  {artifact_name}\n".encode("ascii")
        with tempfile.NamedTemporaryFile(prefix=f".{artifact_name}.", suffix=".sha256.tmp", dir=output_dir, delete=False) as handle:
            temp_sum = Path(handle.name)
            handle.write(checksum_content)
            handle.flush()
            os.fsync(handle.fileno())
        with temp_zip.open("rb+") as handle:
            os.fsync(handle.fileno())
        os.replace(temp_zip, output_path)
        temp_zip = None
        try:
            os.replace(temp_sum, checksum_path)
        except Exception:
            output_path.unlink(missing_ok=True)
            raise
        temp_sum = None
    except Exception:
        if temp_zip is not None:
            temp_zip.unlink(missing_ok=True)
        if temp_sum is not None:
            temp_sum.unlink(missing_ok=True)
        raise
    return {
        "package": str(output_path),
        "sha256File": str(checksum_path),
        "sha256": zip_sha,
        "target": target,
        "nodeVersion": NODE_VERSION,
        "files": len(files),
        "published": False,
        "hostRuntimeVersionChecked": bool(verify_native and target == host_target()),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node-version", choices=[NODE_VERSION], default=NODE_VERSION,
                        help="official Node runtime version pinned by this package script")
    parser.add_argument("--target", choices=sorted(NODE_RELEASES), default=host_target() or "darwin-arm64",
                        help="runtime platform target (default: this machine when supported)")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "releases/portable")
    parser.add_argument("--ca-bundle", type=Path,
                        help="TLS CA bundle for the official Node download; SSL_CERT_FILE is also honored")
    parser.add_argument("--archive", "--node-archive", dest="node_archive", type=Path,
                        help="pre-downloaded official Node archive (SHA-256 is still verified)")
    parser.add_argument("--shasums", type=Path,
                        help="pre-downloaded official SHASUMS256.txt (release pin is still checked)")
    args = parser.parse_args(argv)
    try:
        print(json.dumps(build_package(
            target=args.target,
            output_dir=args.output_dir,
            ca_bundle=args.ca_bundle,
            node_archive_path=args.node_archive,
            shasums_path=args.shasums,
        ), ensure_ascii=False))
        return 0
    except Exception as error:
        print(f"Portable package not created: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
