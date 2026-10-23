// One-shot test runner for the J1 bench fixture. The bench's fake model scripts a
// `shell_run` that invokes this file, so the fixture's own test is executed for
// real and the result is reported as process output (exit 0 = pass).
//
// Kept as JS (not TS) so `py runTests.js` works with no tsx bootstrap, matching
// how the generated repo would run its own test on Windows (`py`) or POSIX (`python3`).
import subprocess
import sys
from pathlib import Path


def run(target: Path) -> int:
    proc = subprocess.run(
        [sys.executable, str(target)],
        cwd=str(target.parent),
        capture_output=True,
        text=True,
    )
    if proc.stdout:
        sys.stdout.write(proc.stdout)
    if proc.stderr:
        sys.stderr.write(proc.stderr)
    return proc.returncode


def main(argv: list[str]) -> int:
    # Each argument names a test file (default: test_calc.py next to this script).
    targets = [Path(a).resolve() for a in argv[1:]] or [Path(__file__).resolve().parent / "test_calc.py"]
    failed = 0
    for target in targets:
        if not target.exists():
            sys.stderr.write(f"missing test file: {target}\n")
            failed = 1
            continue
        code = run(target)
        if code != 0:
            failed = code or 1
    return failed


if __name__ == "__main__":
    sys.exit(main(sys.argv))
