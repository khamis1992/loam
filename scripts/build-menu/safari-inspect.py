#!/usr/bin/env python3
import json
import os
import pathlib
import subprocess
import sys

SCHEME = "LoamPageNotes"


def fail(message, code=1):
    print(message, file=sys.stderr)
    raise SystemExit(code)


def find_project(root):
    projects = [item for item in root.rglob("*.xcodeproj") if item.is_dir()]
    if len(projects) != 1:
        fail("expected_one_xcode_project")
    return projects[0]


def build_args(project, info, root):
    schemes = info.get("project", {}).get("schemes", [])
    if SCHEME not in schemes:
        fail("converter_scheme_changed: review toolchain gate")
    return [
        "xcodebuild",
        "-project",
        str(project),
        "-scheme",
        SCHEME,
        "-configuration",
        "Debug",
        "-derivedDataPath",
        str(root / "DerivedData"),
        "CODE_SIGNING_ALLOWED=NO",
        "build",
    ]


def main(argv):
    plan_only = sys.platform != "darwin" and os.environ.get("LOAM_SAFARI_INSPECT") == "plan"
    if sys.platform != "darwin" and not plan_only:
        fail("unsupported_platform: macOS is required", 2)
    if plan_only:
        if len(argv) != 3:
            fail("usage: safari-inspect.py OUTPUT_DIR LIST_JSON", 2)
        root = pathlib.Path(argv[1]).resolve()
        project = find_project(root)
        info = json.loads(pathlib.Path(argv[2]).read_text(encoding="utf-8"))
        print(json.dumps(build_args(project, info, root)))
        return
    if len(argv) != 2:
        fail("usage: safari-inspect.py OUTPUT_DIR", 2)
    root = pathlib.Path(argv[1]).resolve()
    project = find_project(root)
    listed = subprocess.check_output(["xcodebuild", "-list", "-json", "-project", str(project)])
    args = build_args(project, json.loads(listed), root)
    print(json.dumps(args))
    subprocess.run(args, check=True)


if __name__ == "__main__":
    main(sys.argv)
