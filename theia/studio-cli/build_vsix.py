#!/usr/bin/env python3
"""Build the Constructor Studio CLI extension for one platform.

    python studio-cli/build_vsix.py --target win32-x64 --out dist

The VSIX carries, under extension/runtime/:

  python/  a relocatable CPython (python-build-standalone), with `cfs`
           (constructor-studio at theia/cfs.json's `ref`) in its site-packages;
  home/    the home directory `cfs` runs with, holding the skill engine at
           cfs.json's `engine` in home/.cf-studio/cache, where `cfs` and the
           engine's `init` both look -- so a member's own `cfs` and its cache
           are neither used nor touched;
  bin/     `cfs` for a shell, with that home: cfs.cmd on Windows, sh elsewhere.

Nothing here runs the target's Python, so any target builds on any machine with
Python 3.11.4+ and git: `cfs` has no third-party dependencies, its wheel is
unpacked rather than installed, and the engine is fetched by that same code run
on this interpreter. GITHUB_TOKEN, when set, keeps the engine download clear of
api.github.com's anonymous rate limit.

It prints the VSIX's path and SHA-256 -- what a desktop manifest pins.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent
PIN = HERE.parent / "cfs.json"
EXTENSION_FILES = ("package.json", "extension.js", "README.md")
PYTHON_RELEASES = "https://github.com/astral-sh/python-build-standalone/releases/download"
CFS_REPOSITORY = "https://github.com/constructorfabric/studio.git"
# Parts of CPython that `cfs` never imports: a third of the unpacked size.
PRUNED = ("test", "idlelib", "tkinter", "turtledemo", "ensurepip", "lib2to3", "pydoc_data", "site-packages/pip")


def extension_version(pin):
    """`<engine>-<ref>.<build>`: a new pin is a new version, and so a new folder on the desktop."""
    return f"{pin['engine'].lstrip('v')}-{pin['ref'][:7]}.{pin['extension']['build']}"


def vsix_name(version, target):
    """The release asset's name; electron-app/scripts/assistants-manifest.mjs builds the same one."""
    return f"constructorfabric.studio-cli-{version}-{target}.vsix"


def sha256_of(file):
    digest = hashlib.sha256()
    with open(file, "rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url, file):
    print(f"downloading {url}", flush=True)
    request = urllib.request.Request(url, headers={"User-Agent": "studio-cli-build"})
    with urllib.request.urlopen(request, timeout=300) as response, open(file, "wb") as out:
        shutil.copyfileobj(response, out)


def fetch_python(target_pin, release, cache, dest):
    """The target's CPython, checked against its pinned digest, unpacked into `dest`."""
    archive = cache / target_pin["asset"]
    if not archive.exists() or sha256_of(archive) != target_pin["sha256"]:
        download(f"{PYTHON_RELEASES}/{release}/{target_pin['asset'].replace('+', '%2B')}", archive)
    digest = sha256_of(archive)
    if digest != target_pin["sha256"]:
        sys.exit(f"{archive.name}: sha256 {digest}, cfs.json pins {target_pin['sha256']}")
    links = []
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            name = PurePosixPath(member.name)
            # Every member sits under python/; nothing may leave it.
            if name.is_absolute() or ".." in name.parts or name.parts[0] != "python":
                sys.exit(f"{archive.name}: unexpected member {member.name}")
            if member.issym() or member.islnk():
                links.append(member)
                continue
            tar.extract(member, dest, filter="data")
    # A zip keeps no links, and a Windows checkout may not be allowed to make
    # them: a link becomes a copy of what it points at.
    for member in links:
        link = dest / member.name
        source = (link.parent / member.linkname) if member.issym() else dest / member.linkname
        if source.is_file():
            shutil.copy2(source, link)
        elif source.is_dir():
            shutil.copytree(source, link)
    return dest / "python"


def site_packages(python_root, target):
    if target.startswith("win32-"):
        return python_root / "Lib" / "site-packages", python_root / "Lib"
    lib = next((python_root / "lib").glob("python3.*"))
    return lib / "site-packages", lib


def build_cfs_wheel(ref, work):
    wheels = work / "wheels"
    subprocess.run(
        [sys.executable, "-m", "pip", "wheel", "--no-deps", "--quiet", "--wheel-dir", str(wheels),
         f"git+{CFS_REPOSITORY}@{ref}"],
        check=True,
    )
    found = sorted(wheels.glob("constructor_studio-*.whl"))
    if len(found) != 1:
        sys.exit(f"expected one constructor-studio wheel, found {[w.name for w in found]}")
    return found[0]


def fetch_engine(site, engine, cache_dir):
    """The engine as `cfs` itself caches it -- by `cfs`'s own code, so the layout is the one it looks for."""
    code = (
        "import sys\n"
        "from studio_proxy.cache import download_and_cache\n"
        "from studio_proxy.resolve import find_cached_skill\n"
        f"ok, message = download_and_cache(version={engine!r})\n"
        "print(message)\n"
        "entry = find_cached_skill()\n"
        "print('skill engine entry point:', entry)\n"
        "sys.exit(0 if ok and entry else 1)\n"
    )
    env = dict(os.environ, CFS_CACHE_DIR=str(cache_dir), PYTHONPATH=str(site), CFS_NO_VERSION_CHECK="1")
    subprocess.run([sys.executable, "-c", code], check=True, env=env)


def write_shims(bin_dir):
    bin_dir.mkdir(parents=True)
    # setlocal: the home is cfs's alone, never the shell's that typed it.
    # UTF-8 because a Windows console's code page cannot print what cfs
    # writes (a warning sign, a cross) and Python stops at the first such
    # character; no version check because the engine is pinned, and the
    # advice it gives, `cfs update`, would unpin it.
    (bin_dir / "cfs.cmd").write_text(
        '@setlocal\r\n'
        '@set "HOME=%~dp0..\\home"\r\n'
        '@set "USERPROFILE=%~dp0..\\home"\r\n'
        '@set "PYTHONUTF8=1"\r\n'
        '@set "CFS_NO_VERSION_CHECK=1"\r\n'
        '@"%~dp0..\\python\\python.exe" -m studio_proxy %*\r\n',
        encoding="ascii",
    )
    # The sh one serves Git Bash on Windows too, where the interpreter is
    # python.exe and needs Windows paths (`pwd -W`).
    (bin_dir / "cfs").write_text(
        '#!/bin/sh\n'
        'here="$(cd "$(dirname "$0")/.." && { pwd -W 2>/dev/null || pwd; })"\n'
        'python="$here/python/bin/python3"\n'
        '[ -x "$python" ] || python="$here/python/python.exe"\n'
        'HOME="$here/home" USERPROFILE="$here/home" PYTHONUTF8=1 CFS_NO_VERSION_CHECK=1 '
        'exec "$python" -m studio_proxy "$@"\n',
        encoding="ascii",
    )


def vsix_manifest(package, target):
    return f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{package['name']}" Version="{package['version']}" Publisher="{package['publisher']}" TargetPlatform="{target}"/>
    <DisplayName>{package['displayName']}</DisplayName>
    <Description xml:space="preserve">{package['description']}</Description>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>
"""


CONTENT_TYPES = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
"""


def zip_tree(root, file):
    with zipfile.ZipFile(file, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(root.rglob("*")):
            if path.is_file():
                info = zipfile.ZipInfo.from_file(path, path.relative_to(root).as_posix())
                # rwxr-xr-x for everything: a POSIX unpacker that honours
                # modes can run the interpreter and the shim.
                info.external_attr = (0o100755 << 16)
                info.compress_type = zipfile.ZIP_DEFLATED
                with open(path, "rb") as stream:
                    archive.writestr(info, stream.read())


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--target", required=True, help="win32-x64, linux-x64 or darwin-arm64")
    parser.add_argument("--out", default=str(HERE / "dist"))
    parser.add_argument("--cache", help="where downloads are kept between builds")
    args = parser.parse_args()

    pin = json.loads(PIN.read_text(encoding="utf-8"))
    targets = pin["extension"]["python"]["targets"]
    if args.target not in targets:
        sys.exit(f"--target {args.target}: cfs.json pins a Python for {', '.join(targets)}")
    version = extension_version(pin)
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="scli-") as temp:
        work = Path(temp)
        cache = Path(args.cache).resolve() if args.cache else work
        cache.mkdir(parents=True, exist_ok=True)
        stage = work / "vsix"
        extension = stage / "extension"
        runtime = extension / "runtime"
        runtime.mkdir(parents=True)

        package = json.loads((HERE / "package.json").read_text(encoding="utf-8"))
        package["version"] = version
        package.pop("private", None)
        (extension / "package.json").write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")
        for name in EXTENSION_FILES[1:]:
            if (HERE / name).exists():
                shutil.copy2(HERE / name, extension / name)

        python_root = fetch_python(targets[args.target], pin["extension"]["python"]["release"], cache, runtime)
        site, lib = site_packages(python_root, args.target)
        for name in PRUNED:
            shutil.rmtree(lib / name, ignore_errors=True)
        for pip_info in site.glob("pip-*.dist-info"):
            shutil.rmtree(pip_info)
        if args.target.startswith("win32-"):
            shutil.rmtree(python_root / "tcl", ignore_errors=True)
            shutil.rmtree(python_root / "Scripts", ignore_errors=True)

        with zipfile.ZipFile(build_cfs_wheel(pin["ref"], work)) as wheel:
            wheel.extractall(site)
        fetch_engine(site, pin["engine"], runtime / "home" / ".cf-studio" / "cache")
        write_shims(runtime / "bin")
        (runtime / "cfs.json").write_text(json.dumps(
            {"ref": pin["ref"], "engine": pin["engine"], "python": pin["extension"]["python"]["version"]}, indent=2
        ) + "\n", encoding="utf-8")

        (stage / "extension.vsixmanifest").write_text(vsix_manifest(package, args.target), encoding="utf-8")
        (stage / "[Content_Types].xml").write_text(CONTENT_TYPES, encoding="utf-8")

        vsix = out / vsix_name(version, args.target)
        zip_tree(stage, vsix)

    size = vsix.stat().st_size
    print(json.dumps({"file": str(vsix), "version": version, "target": args.target,
                      "size": size, "sha256": sha256_of(vsix)}))


if __name__ == "__main__":
    main()
