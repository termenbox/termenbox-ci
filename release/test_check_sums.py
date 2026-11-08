import hashlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import check_sums  # noqa: E402


class CheckSums(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.names = list(check_sums.REQUIRED) + ["install.sh"]
        for n in self.names:
            (self.dir / n).write_bytes(n.encode())
        self.manifest = self.dir / "manifest.json"

    def tearDown(self):
        self.tmp.cleanup()

    def sums(self, names=None):
        names = names or self.names
        return "".join(f"{hashlib.sha256((self.dir / n).read_bytes()).hexdigest()}  {n}\n" for n in names)

    def refused(self, text):
        with self.assertRaises(SystemExit) as raised:
            check_sums.check(text, self.dir, self.manifest)
        self.assertIn("SHA256SUMS refused", str(raised.exception))

    def test_the_sums_of_the_release_files_pass_with_or_without_the_installer(self):
        check_sums.check(self.sums(), self.dir, self.manifest)
        check_sums.check(self.sums(list(check_sums.REQUIRED)), self.dir, self.manifest)

    def test_a_changed_file_is_refused(self):
        text = self.sums()
        (self.dir / "install.sh").write_bytes(b"other")
        self.refused(text)

    def test_an_extra_missing_or_repeated_name_is_refused(self):
        self.refused(self.sums() + "0" * 64 + "  evil.sh\n")
        self.refused(self.sums([n for n in self.names if n != "NOTICES"]))
        self.refused(self.sums() + self.sums(["NOTICES"]))

    def test_a_malformed_line_or_a_path_is_refused(self):
        self.refused(self.sums() + "not a line\n")
        self.refused(self.sums() + "0" * 64 + "  ../install.sh\n")

    def test_a_manifest_other_than_the_signed_one_is_refused(self):
        other = self.dir / "signed.json"
        other.write_bytes(b"another manifest")
        with self.assertRaises(SystemExit):
            check_sums.check(self.sums(), self.dir, other)

    def test_the_command_line_exits_non_zero_on_a_refusal(self):
        script = str(Path(__file__).parent / "check_sums.py")
        path = self.dir / "SHA256SUMS"
        path.write_text(self.sums())
        ok = subprocess.run([sys.executable, script, str(path), str(self.dir), str(self.manifest)], capture_output=True)
        self.assertEqual(ok.returncode, 0)
        path.write_text(self.sums() + "junk\n")
        bad = subprocess.run([sys.executable, script, str(path), str(self.dir), str(self.manifest)], capture_output=True)
        self.assertNotEqual(bad.returncode, 0)


if __name__ == "__main__":
    unittest.main()
