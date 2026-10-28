#!/usr/bin/env python3
"""Pack a gearbox engine as the extension a desktop fetches.

    python gearbox-engine/build_vsix.py --engine target/release/gearbox.exe \\
        --ref <STUDIO_GEARBOX_REF> --target win32-x64 --out dist

The VSIX carries the executable at extension/bin/gearbox[.exe], where
electron-app/desktop-main.js points GEARBOX_ENGINE. Its version is this
folder's package.json version (raised when the packaging changes) and the
engine's revision: `0.1.0-3b64969`. The same rule is in
electron-app/scripts/assistants-manifest.mjs (`gearboxEngineVersion`).

It prints the VSIX's path and SHA-256.
"""

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent


def engine_version(package_version, ref):
    return f"{package_version}-{ref[:7]}"


def vsix_name(version, target):
    """The release asset's name; assistants-manifest.mjs builds the same one."""
    return f"constructorfabric.gearbox-engine-{version}-{target}.vsix"


def sha256_of(file):
    digest = hashlib.sha256()
    with open(file, "rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--engine", required=True, help="the built gearbox executable")
    parser.add_argument("--ref", required=True, help="the revision it was built from")
    parser.add_argument("--target", default="win32-x64")
    parser.add_argument("--out", default=str(HERE / "dist"))
    args = parser.parse_args()

    engine = Path(args.engine)
    if not engine.is_file():
        sys.exit(f"--engine {engine}: no such file")
    if len(args.ref) < 7:
        sys.exit("--ref must be a commit")
    package = json.loads((HERE / "package.json").read_text(encoding="utf-8"))
    version = engine_version(package["version"], args.ref)
    package["version"] = version
    package.pop("private", None)
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    name = "gearbox.exe" if args.target.startswith("win32-") else "gearbox"

    with tempfile.TemporaryDirectory(prefix="gbx-") as temp:
        stage = Path(temp)
        extension = stage / "extension"
        (extension / "bin").mkdir(parents=True)
        (extension / "package.json").write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")
        shutil.copy2(HERE / "README.md", extension / "README.md")
        shutil.copy2(engine, extension / "bin" / name)
        (extension / "revision.txt").write_text(args.ref + "\n", encoding="ascii")
        (stage / "extension.vsixmanifest").write_text(f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{package['name']}" Version="{version}" Publisher="{package['publisher']}" TargetPlatform="{args.target}"/>
    <DisplayName>{package['displayName']}</DisplayName>
    <Description xml:space="preserve">{package['description']}</Description>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>
""", encoding="utf-8")
        (stage / "[Content_Types].xml").write_text("""<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
""", encoding="utf-8")
        vsix = out / vsix_name(version, args.target)
        with zipfile.ZipFile(vsix, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in sorted(stage.rglob("*")):
                if path.is_file():
                    info = zipfile.ZipInfo.from_file(path, path.relative_to(stage).as_posix())
                    info.external_attr = (0o100755 << 16)
                    info.compress_type = zipfile.ZIP_DEFLATED
                    with open(path, "rb") as stream:
                        archive.writestr(info, stream.read())

    print(json.dumps({"file": str(vsix), "version": version, "target": args.target,
                      "size": vsix.stat().st_size, "sha256": sha256_of(vsix)}))


if __name__ == "__main__":
    main()
