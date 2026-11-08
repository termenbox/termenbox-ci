#!/usr/bin/env python3
"""Tests for release_plan.py: a tag selects exactly one channel, and aliases only ever move forward."""
import unittest
from pathlib import Path
import importlib.util

spec = importlib.util.spec_from_file_location("release_plan", Path(__file__).with_name("release_plan.py"))
rp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rp)


class Tags(unittest.TestCase):
    def test_a_stable_tag_is_stable_and_feeds_latest_and_the_beta_alias(self):
        p = rp.from_tag("v0.2.0")
        self.assertEqual((p["channel"], p["version"], p["latest"], p["prerelease"]), ("stable", "0.2.0", True, False))
        self.assertEqual(p["docker_tags"], ["latest", "0.2", "0.2.0"])
        self.assertEqual(p["aliases"], ["channel-beta"])

    def test_beta_and_rc_tags_are_beta_prereleases(self):
        for tag in ("v0.2.0-rc.1", "v0.2.0-beta.3"):
            p = rp.from_tag(tag)
            self.assertEqual((p["channel"], p["version"], p["core"]), ("beta", tag[1:], "0.2.0"))
            self.assertEqual((p["prerelease"], p["latest"], p["docker_tags"]), (True, False, ["beta", tag[1:]]))

    def test_no_other_tag_reaches_a_release(self):
        for tag in ("v0.2.0-nightly", "v2026.10.22-nightly", "v0.2", "v0.2.0.1", "v01.2.3", "v1.2.3-alpha.1",
                    "v1.2.3-rc", "v1.2.3-rc.01", "v1.2.3-rc.1+x", "0.2.0", "v1.2.3 ", "latest"):
            self.assertEqual(rp.from_tag(tag)["channel"], "none", tag)

    def test_a_later_nightly_of_the_day_is_numbered_and_sorts_after_the_first(self):
        first, second, third = (rp.nightly("0.1.58", "20261106", n) for n in (1, 2, 3))
        self.assertEqual((second["tag"], second["version"]), ("v2026.11.06-nightly.2", "0.1.58-nightly.20261106.2"))
        self.assertEqual(first["version"], "0.1.58-nightly.20261106")
        order = [first["version"], second["version"], third["version"], "0.1.58-nightly.20261107"]
        self.assertEqual(sorted(reversed(order), key=rp.key), order)
        self.assertTrue(rp.newer(second["version"], first["version"]))
        self.assertTrue(rp.newer("0.1.58-nightly.20261107", third["version"]))

    def test_a_nightly_has_a_dated_tag_and_a_prerelease_version(self):
        p = rp.nightly("0.1.36", "20261022")
        self.assertEqual((p["tag"], p["version"]), ("v2026.10.22-nightly", "0.1.36-nightly.20261022"))
        self.assertEqual((p["docker_tags"], p["aliases"]), (["nightly", "0.1.36-nightly.20261022"], ["channel-nightly"]))
        self.assertEqual((p["prerelease"], p["latest"]), (True, False))


class Order(unittest.TestCase):
    def test_semver_precedence(self):
        ordered = ["0.1.36-nightly.20261022", "0.1.36-nightly.20261023", "0.1.36", "0.1.37-rc.1", "0.1.37-rc.2",
                   "0.1.37-rc.10", "0.1.37", "0.2.0", "1.0.0"]
        for lower, higher in zip(ordered, ordered[1:]):
            self.assertTrue(rp.newer(higher, lower), f"{higher} > {lower}")
            self.assertFalse(rp.newer(lower, higher), f"{lower} < {higher}")

    def test_an_equal_version_is_not_newer_and_build_metadata_is_ignored(self):
        self.assertFalse(rp.newer("0.2.0", "0.2.0"))
        self.assertFalse(rp.newer("0.2.0+b2", "0.2.0+b1"))

    def test_a_stable_release_replaces_the_rc_it_came_from(self):
        self.assertTrue(rp.newer("0.2.0", "0.2.0-rc.3"))
        self.assertFalse(rp.newer("0.2.0-rc.3", "0.2.0"))


class Freeze(unittest.TestCase):
    def manifest(self, version, freeze):
        import json, tempfile
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump({"version": version, "freeze": freeze}, f)
        f.close()
        return f.name

    def test_a_release_passes_when_the_channel_is_not_frozen(self):
        self.assertTrue(rp.thaws("0.2.0", self.manifest("0.2.0", False)))

    def test_a_frozen_channel_lets_through_only_a_release_newer_than_the_freeze(self):
        frozen = self.manifest("0.2.1", True)
        self.assertFalse(rp.thaws("0.2.0", frozen))
        self.assertFalse(rp.thaws("0.2.1", frozen))
        self.assertTrue(rp.thaws("0.2.2", frozen))


if __name__ == "__main__":
    unittest.main()
