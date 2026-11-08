#!/usr/bin/env python3
"""Tests for image_digests.py: the two linux images are found among attestations, anything less is refused."""
import unittest

import json
import os
import tempfile
from unittest import mock

import image_digests
from image_digests import digests_from_index, failed_job, failed_run, image_problem

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


def job(name, conclusion):
    return {"name": name, "status": "completed" if conclusion else "in_progress", "conclusion": conclusion}


def run(id, title, conclusion):
    return {"id": id, "display_title": title, "conclusion": conclusion}


class BuildEndedWithoutAnImage(unittest.TestCase):
    def test_a_failed_job_of_the_image_call_ends_the_wait_and_this_jobs_own_name_does_not(self):
        jobs = [job("Release / Image digests", None), job("Image / Plan the image tags", "failure"), job("Image / Build amd64", "skipped")]
        self.assertEqual(failed_job(jobs, "Image / "), ("Image / Plan the image tags", "failure"))

    def test_a_cancelled_build_ends_the_wait(self):
        self.assertEqual(failed_job([job("Image / Build arm64", "cancelled")], "Image / "), ("Image / Build arm64", "cancelled"))

    def test_running_succeeded_and_skipped_jobs_do_not(self):
        jobs = [job("Image / Plan the image tags", "success"), job("Image / Build amd64", None), job("Image / Build arm64", "skipped")]
        self.assertIsNone(failed_job(jobs, "Image / "))
        self.assertIsNone(failed_job([], "Image / "))

    def test_a_failure_of_another_job_does_not(self):
        self.assertIsNone(failed_job([job("Build (x86_64)", "failure")], "Image / "))

    def test_the_newest_run_with_the_title_decides(self):
        runs = [run(5, "Image v1.2.3", "failure"), run(9, "Image v1.2.3", None), run(7, "Image v1.2.2", "failure")]
        self.assertIsNone(failed_run(runs, "Image v1.2.3"))
        self.assertEqual(failed_run([run(5, "Image v1.2.3", "success"), run(8, "Image v1.2.3", "cancelled")], "Image v1.2.3"), ("Image v1.2.3", "cancelled"))

    def test_no_run_with_the_title_or_another_titles_failure_does_not(self):
        self.assertIsNone(failed_run([], "Image v1.2.3"))
        self.assertIsNone(failed_run([run(7, "Image v1.2.2", "failure")], "Image v1.2.3"))


SHA = "1" * 40
START = "2026-11-07T10:00:00Z"


def config(revision=SHA, created="2026-11-07T10:20:00Z"):
    return {"created": created, "config": {"Labels": {"org.opencontainers.image.revision": revision}}}


class ImageDigestMustComeFromThisRunsBuild(unittest.TestCase):
    def test_an_image_of_this_commit_made_after_the_run_started_is_accepted(self):
        self.assertIsNone(image_problem(config(), SHA, START))

    def test_an_image_made_before_the_run_started_is_refused(self):
        self.assertIn("before", image_problem(config(created="2026-11-07T09:59:59Z"), SHA, START))

    def test_an_image_of_another_commit_or_without_the_label_is_refused(self):
        self.assertIn("revision", image_problem(config(revision="2" * 40), SHA, START))
        self.assertIn("revision", image_problem({"created": "2026-11-07T10:20:00Z", "config": {}}, SHA, START))

    def test_an_unreadable_creation_time_is_refused(self):
        self.assertIsNotNone(image_problem(config(created=""), SHA, START))
        self.assertIsNotNone(image_problem(config(created="yesterday"), SHA, START))

    def test_image_digest_must_come_from_this_runs_build(self):
        """A tag pre-seeded with another image makes the release job fail and writes no digests."""
        index = {"manifests": [entry("amd64", A), entry("arm64", B)]}
        seeded = config(revision="2" * 40, created="2026-11-06T00:00:00Z")
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "digests.json")
            argv = ["x", "ghcr.io/o/i:1.2.3", out, "--commit", SHA, "--run-start", START]
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

    def test_the_run_start_is_the_newest_run_with_the_title(self):
        runs = [{"id": 5, "display_title": "Image v1", "run_started_at": "2026-11-07T08:00:00Z", "head_sha": SHA},
                {"id": 9, "display_title": "Image v1", "run_started_at": START, "head_sha": SHA}]
        self.assertEqual(image_digests.run_start(runs, "Image v1"), START)
        self.assertIsNone(image_digests.run_start(runs, "Image v2"))


if __name__ == "__main__":
    unittest.main()
