import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "src"))
from discounts import apply_discount  # noqa: E402


def main() -> int:
    cases = [
        ((100.0, 0.2), 80.0),
        ((50.0, 0.0), 50.0),
        ((9.99, 0.1), 8.99),
        ((10.0, 1.0), 0.0),
    ]
    for (price, rate), expected in cases:
        actual = apply_discount(price, rate)
        if actual != expected:
            print(f"apply_discount({price}, {rate}) = {actual}, expected {expected}")
            return 1
    try:
        apply_discount(10.0, 1.5)
    except ValueError:
        pass
    else:
        print("out-of-range rate must raise ValueError")
        return 1
    print("task-009 ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
