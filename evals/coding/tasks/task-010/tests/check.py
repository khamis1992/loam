import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "src"))
from parser import parse_pairs  # noqa: E402


def main() -> int:
    cases = [
        ("a=1;b=2", {"a": "1", "b": "2"}),
        ("  x = 10 ; y = 20 ", {"x": "10", "y": "20"}),
        ("broken;a=1", {"a": "1"}),
        ("", {}),
        ("k=v=w", {"k": "v=w"}),
    ]
    for text, expected in cases:
        actual = parse_pairs(text)
        if actual != expected:
            print(f"parse_pairs({text!r}) = {actual!r}, expected {expected!r}")
            return 1
    print("task-010 ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
