"""Unit tests of the output escaping in scripts/feedback-read.py.

Run: python3 -m unittest discover -s test -p '*_test.py'
"""

import importlib.util
import json
import pathlib
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent.parent / "scripts" / "feedback-read.py"
spec = importlib.util.spec_from_file_location("feedback_read", SCRIPT)
feedback_read = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feedback_read)
safe = feedback_read.safe


class SafeTest(unittest.TestCase):
    def test_controls_are_escaped(self):
        for raw, want in [
            ("\x1b[2J", "\\u001b[2J"),
            ("\u009b31mX", "\\u009b31mX"),
            ("\u009d0;title\x07", "\\u009d0;title\\u0007"),
            ("a‮b", "a\\u202eb"),
            ("a⁦b⁩", "a\\u2066b\\u2069"),
            ("a b", "a\\u2028b"),
            ("tab\there", "tab\\u0009here"),
            ("line\nbreak", "line\\u000abreak"),
            ("tag\U000e0041", "tag\\udb40\\udc41"),
        ]:
            self.assertEqual(safe(raw), want, repr(raw))

    def test_printable_text_is_kept(self):
        text = "Ação no instalador: 日本語, emoji \U0001f600, aspas \"x\""
        self.assertEqual(safe(text), text)

    def test_kept_newlines_and_valid_json(self):
        sub = {"message": "hi\u009b31m\nnext‮", "system": {"k\u0085": "v"}}
        out = safe(json.dumps(sub, indent=2, ensure_ascii=False), keep="\n")
        self.assertIn("\n", out)
        self.assertTrue(all(c == "\n" or c.isprintable() for c in out))
        self.assertEqual(json.loads(out), sub)
        line = safe(json.dumps(sub, ensure_ascii=False))
        self.assertTrue(line.isprintable())
        self.assertEqual(json.loads(line), sub)


if __name__ == "__main__":
    unittest.main()
