#!/usr/bin/env python3
"""Tests for image_digests.py: the two linux images are found among attestations, anything less is refused."""
import unittest

import json
import os
import tempfile
from unittest import mock

import image_digests
from image_digests import digests_from_index, image_problem

A, B, C = ("sha256:" + c * 64 for c in "abc")


def entry(arch, digest, os="linux"):
    return {"digest": digest, "platform": {"architecture": arch, "os": os}}


class ImageDigests(unittest.TestCase):
    def test_both_linux_images_are_found_and_attestations_are_skipped(self):
        index = {"manifests": [entry("amd64", A), entry("arm64", B), entry("unknown", C, os="unknown")]}
        self.assertEqual(digests_from_index(index), {"x86_64": A, "aarch64": B})

    def test_a_missing_architecture_is_refused(self):
        with self.assertRaises(ValueError):
            digests_from_index({"manifests": [entry("amd64", A)]})

    def test_a_malformed_digest_is_ignored_and_so_the_architecture_is_missing(self):
        with self.assertRaises(ValueError):
            digests_from_index({"manifests": [entry("amd64", A), entry("arm64", "sha256:xyz")]})

    def test_two_different_images_for_one_architecture_are_refused(self):
        with self.assertRaises(ValueError):
            digests_from_index({"manifests": [entry("amd64", A), entry("amd64", C), entry("arm64", B)]})


SHA = "1" * 40


RUN_ID = "4242"


def config(revision=SHA, run=RUN_ID):
    labels = {"org.opencontainers.image.revision": revision}
    if run is not None:
        labels["dev.termenbox.release.run"] = run
    return {"created": "2026-11-07T10:20:00Z", "config": {"Labels": labels}}


class ImageDigestMustComeFromThisRunsBuild(unittest.TestCase):
    def test_an_image_of_this_commit_and_this_run_is_accepted_whatever_its_creation_time(self):
        self.assertIsNone(image_problem(config(), SHA, RUN_ID))
        old = config()
        old["created"] = "2020-01-01T00:00:00Z"
        self.assertIsNone(image_problem(old, SHA, RUN_ID))

    def test_an_image_of_another_run_or_without_the_run_label_is_refused(self):
        self.assertIn("run", image_problem(config(run="1"), SHA, RUN_ID))
        self.assertIn("run", image_problem(config(run=None), SHA, RUN_ID))
        self.assertIn("run", image_problem(config(), SHA, ""))

    def test_an_image_of_another_commit_or_without_the_label_is_refused(self):
        self.assertIn("revision", image_problem(config(revision="2" * 40), SHA, RUN_ID))
        self.assertIn("revision", image_problem({"created": "2026-11-07T10:20:00Z", "config": {}}, SHA, RUN_ID))

    def test_image_digest_must_come_from_this_runs_build(self):
        """A tag pre-seeded with another image makes the release job fail and writes no digests."""
        index = {"manifests": [entry("amd64", A), entry("arm64", B)]}
        seeded = config(run="1")
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "digests.json")
            argv = ["x", "ghcr.io/o/i:1.2.3", out, "--commit", SHA, "--run-id", RUN_ID]
            with mock.patch.object(image_digests, "inspect", return_value=index), \
                    mock.patch.object(image_digests, "image_config", return_value=seeded):
                with self.assertRaises(SystemExit) as raised:
                    image_digests.main(argv)
            self.assertNotEqual(raised.exception.code, 0)
            self.assertFalse(os.path.exists(out))
            with mock.patch.object(image_digests, "inspect", return_value=index), \
                    mock.patch.object(image_digests, "image_config", return_value=config()):
                image_digests.main(argv)
            self.assertEqual(json.load(open(out)), {"x86_64": A, "aarch64": B})

    def test_a_tag_that_is_not_there_yet_is_refused_at_once(self):
        with mock.patch.object(image_digests, "inspect", side_effect=ValueError("manifest unknown")):
            with self.assertRaises(SystemExit) as raised:
                image_digests.main(["x", "ghcr.io/o/i:1.2.3", "/nonexistent/out.json", "--commit", SHA, "--run-id", RUN_ID])
        self.assertIn("manifest unknown", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
