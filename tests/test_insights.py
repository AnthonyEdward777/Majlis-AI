import unittest

import _testdb  # noqa: F401  (mocks heavy libraries)
from insights import parse_insights


class ParseInsightsTests(unittest.TestCase):
    def test_valid_json_is_cleaned(self):
        out = parse_insights('{"summary":" s ","decisions":["a","",5],"action_items":[{"description":"do","deadline":"Fri"},{"x":1},"bad"]}')
        self.assertEqual(out["summary"], "s")
        self.assertEqual(out["decisions"], ["a"])
        self.assertEqual(out["action_items"], [{"description": "do", "responsible_person": "", "deadline": "Fri"}])

    def test_broken_json_degrades_to_summary_only(self):
        out = parse_insights("plain text summary")
        self.assertEqual(out, {"summary": "plain text summary", "decisions": [], "action_items": []})

    def test_non_object_json_degrades_too(self):
        self.assertEqual(parse_insights("[1,2]")["decisions"], [])


if __name__ == "__main__":
    unittest.main()
