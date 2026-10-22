import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from geometry import area, perimeter  # noqa: E402


class GeometryTests(unittest.TestCase):
    def test_area(self):
        self.assertEqual(area(3, 4), 12)
        self.assertEqual(area(2.5, 2), 5.0)

    def test_area_zero(self):
        self.assertEqual(area(0, 5), 0)
        self.assertEqual(area(0, 0), 0)

    def test_perimeter(self):
        self.assertEqual(perimeter(3, 4), 14)
        self.assertEqual(perimeter(1.5, 1.5), 6.0)

    def test_perimeter_zero(self):
        self.assertEqual(perimeter(0, 0), 0)


if __name__ == "__main__":
    unittest.main()
