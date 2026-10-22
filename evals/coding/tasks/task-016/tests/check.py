import subprocess
import sys
import tempfile
from pathlib import Path


def run_suite(root: Path) -> int:
    return subprocess.run(
        [sys.executable, "test/test_geometry.py"],
        cwd=root,
        capture_output=True,
        text=True,
    ).returncode


def main() -> int:
    cwd = Path.cwd()
    if not (cwd / "test" / "test_geometry.py").exists():
        print("missing test/test_geometry.py")
        return 1

    if run_suite(cwd) != 0:
        print("agent tests failed on the correct source")
        return 1

    with tempfile.TemporaryDirectory() as tmp:
        mutant = Path(tmp)
        (mutant / "src").mkdir()
        (mutant / "test").mkdir()
        source = (cwd / "src" / "geometry.py").read_text(encoding="utf-8")
        broken = source.replace("return 2 * (width + height)", "return width + height")
        (mutant / "src" / "geometry.py").write_text(broken, encoding="utf-8")
        (mutant / "test" / "test_geometry.py").write_text(
            (cwd / "test" / "test_geometry.py").read_text(encoding="utf-8"), encoding="utf-8"
        )
        if run_suite(mutant) == 0:
            print("agent tests still pass when perimeter() is broken; they do not check it")
            return 1

    print("task-016 ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
