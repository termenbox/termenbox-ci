import copy
import hashlib
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import check_manifest  # noqa: E402

V, C = "1.2.3-beta.1", "beta"
BASE = f"https://dl.termenbox.dev/{C}/{V}"
NAMES = [f"termenbox-server-{a}-linux" for a in ("x86_64", "aarch64")] + [f"tmux-{a}-linux" for a in ("x86_64", "aarch64")] + list(check_manifest.NOTICES)


def build(assets):
    def entry(name):
        data = name.encode()
        (assets / name).write_bytes(data)
        return {"url": f"{BASE}/{name}", "sha256": hashlib.sha256(data).hexdigest()}
    return {
        "version": V, "channel": C, "freeze": False, "issued_at": int(time.time()), "notes": "",
        "binaries": {a: entry(f"termenbox-server-{a}-linux") for a in ("x86_64", "aarch64")},
        "tmux": {a: entry(f"tmux-{a}-linux") for a in ("x86_64", "aarch64")},
        "tmux_notices": {n: entry(n) for n in check_manifest.NOTICES},
    }


class CheckManifest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.assets = Path(self.dir.name)
        self.m = build(self.assets)

    def tearDown(self):
        self.dir.cleanup()

    def refused(self, m, version=V, channel=C):
        with self.assertRaises(SystemExit) as raised:
            check_manifest.check(m, self.assets, version, channel)
        self.assertIn("manifest refused", str(raised.exception))

    def test_the_manifest_of_the_built_files_passes(self):
        check_manifest.check(self.m, self.assets, V, C)
        self.m["image"] = {a: "sha256:" + "a" * 64 for a in ("x86_64", "aarch64")}
        check_manifest.check(self.m, self.assets, V, C)

    def test_another_version_or_channel_is_refused(self):
        self.refused(self.m, version="1.2.3")
        self.refused(self.m, channel="stable")

    def test_a_changed_file_or_hash_is_refused(self):
        (self.assets / "tmux-x86_64-linux").write_bytes(b"other")
        self.refused(self.m)

    def test_an_address_off_the_download_path_is_refused(self):
        self.m["binaries"]["x86_64"]["url"] = "https://example.com/termenbox-server-x86_64-linux"
        self.refused(self.m)

    def test_an_extra_key_or_entry_is_refused(self):
        for mutate in (lambda m: m.update(run="x"), lambda m: m["binaries"].update(riscv=m["binaries"]["x86_64"]), lambda m: m["tmux"]["x86_64"].update(extra=1)):
            m = copy.deepcopy(self.m)
            mutate(m)
            self.refused(m)

    def test_a_freeze_a_stale_time_or_a_bad_image_is_refused(self):
        for mutate in (lambda m: m.update(freeze=True), lambda m: m.update(issued_at=1), lambda m: m.update(issued_at=True), lambda m: m.update(image={"x86_64": "latest"})):
            m = copy.deepcopy(self.m)
            mutate(m)
            self.refused(m)

    def test_the_command_line_exits_non_zero_on_a_refusal(self):
        import json
        path = self.assets / "m.json"
        path.write_text(json.dumps(self.m))
        script = str(Path(__file__).parent / "check_manifest.py")
        ok = subprocess.run([sys.executable, script, str(path), str(self.assets), V, C], capture_output=True)
        self.assertEqual(ok.returncode, 0)
        bad = subprocess.run([sys.executable, script, str(path), str(self.assets), V, "stable"], capture_output=True)
        self.assertNotEqual(bad.returncode, 0)


if __name__ == "__main__":
    unittest.main()
