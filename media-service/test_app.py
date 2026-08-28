"""Tests for the media worker. Standard library only.

    python3 media-service/test_app.py

No pytest, no requirements file, no virtualenv. This service is deliberately
plain Python so it can run anywhere, and a test suite that needs a toolchain the
service does not is a test suite that stops being run.
"""
from __future__ import annotations

import importlib.util
import pathlib
import shutil
import sys
import tempfile
import unittest

_spec = importlib.util.spec_from_file_location(
    "ipropy_media_app", pathlib.Path(__file__).with_name("app.py")
)
assert _spec and _spec.loader
app = importlib.util.module_from_spec(_spec)
sys.modules["ipropy_media_app"] = app
_spec.loader.exec_module(app)


class SweepStale(unittest.TestCase):
    """Copies made under a property's old name must not pile up beside the new ones.

    B12 went from twelve photographs to twenty-four after somebody added the
    locality to the record: the filenames are built from the record, so the next
    run wrote a complete second set rather than overwriting the first, and the
    website would have shown every room twice.
    """

    UNIT = "B12"
    PREFIX = "b12-greenfield-colony-sector-15-4-bhk"
    OLD = "b12-greenfield-colony-4-bhk"

    def setUp(self) -> None:
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.root = self.tmp / "B12-4bhk"
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

        for template in app.DERIVATIVE_FOLDERS:
            folder = self.root / template.format(u=self.UNIT)
            folder.mkdir(parents=True)
            for i in (1, 2):
                (folder / f"{self.OLD}-{i:02d}.jpg").write_text("stale")
                (folder / f"{self.PREFIX}-{i:02d}.jpg").write_text("fresh")
            # Two things a person might have put there by hand.
            (folder / "site plan.jpg").write_text("theirs")
            (folder / "notes.txt").write_text("theirs")

        self.raw = self.root / f"{self.UNIT}-RAW-UPLOADS/PHOTOS"
        self.raw.mkdir(parents=True)
        (self.raw / f"{self.OLD}-01.jpg").write_text("the original")

        self.video = self.root / f"{self.UNIT}-VIDEO"
        self.video.mkdir(parents=True)
        (self.video / f"{self.OLD}-01.jpg").write_text("a cover frame")

    def sweep(self, prefix: str | None = None) -> int:
        return app.sweep_stale(str(self.root), self.UNIT, self.PREFIX if prefix is None else prefix)

    def test_moves_every_stale_copy_out_of_every_derivative_folder(self) -> None:
        self.assertEqual(self.sweep(), 2 * len(app.DERIVATIVE_FOLDERS))
        for template in app.DERIVATIVE_FOLDERS:
            folder = self.root / template.format(u=self.UNIT)
            self.assertEqual(
                sorted(p.name for p in folder.iterdir()),
                sorted([f"{self.PREFIX}-01.jpg", f"{self.PREFIX}-02.jpg",
                        "site plan.jpg", "notes.txt"]),
                f"wrong contents left in {template}",
            )

    def test_keeps_the_current_run(self) -> None:
        self.sweep()
        folder = self.root / app.DERIVATIVE_FOLDERS[0].format(u=self.UNIT)
        self.assertTrue((folder / f"{self.PREFIX}-01.jpg").is_file())

    def test_leaves_files_a_person_added(self) -> None:
        self.sweep()
        folder = self.root / app.DERIVATIVE_FOLDERS[0].format(u=self.UNIT)
        self.assertTrue((folder / "site plan.jpg").is_file())
        self.assertTrue((folder / "notes.txt").is_file())

    def test_never_touches_the_originals(self) -> None:
        """The one folder whose contents cannot be regenerated."""
        self.sweep()
        self.assertTrue((self.raw / f"{self.OLD}-01.jpg").is_file())

    def test_never_touches_the_video_folder(self) -> None:
        self.sweep()
        self.assertTrue((self.video / f"{self.OLD}-01.jpg").is_file())

    def test_stale_copies_are_archived_not_deleted(self) -> None:
        self.sweep()
        archive = self.root / f"{self.UNIT}-ARCHIVE"
        found = [p for p in archive.rglob("*") if p.is_file()]
        self.assertEqual(len(found), 2 * len(app.DERIVATIVE_FOLDERS))
        self.assertTrue(all(p.name.startswith(self.OLD) for p in found))

    def test_does_nothing_without_a_name_to_compare_against(self) -> None:
        """No prefix means the caller does not know what the files should be called."""
        self.assertEqual(self.sweep(prefix=""), 0)
        folder = self.root / app.DERIVATIVE_FOLDERS[0].format(u=self.UNIT)
        self.assertTrue((folder / f"{self.OLD}-01.jpg").is_file())

    def test_is_safe_to_run_twice(self) -> None:
        self.sweep()
        self.assertEqual(self.sweep(), 0)


class UnitOfFolder(unittest.TestCase):
    """The unit name is read off the folder, and everything downstream keys off it."""

    def test_reads_the_unit_from_the_folder_name(self) -> None:
        self.assertEqual(app.unit_of("B12-4bhk"), "B12")
        self.assertEqual(app.unit_of("A1818-4bhk-250sqyd"), "A1818")

    def test_reads_the_last_segment_of_a_path(self) -> None:
        self.assertEqual(app.unit_of("/data/properties/B12-4bhk"), "B12")

    def test_falls_back_rather_than_returning_nothing(self) -> None:
        self.assertEqual(app.unit_of(""), "PROPERTY")
        self.assertEqual(app.unit_of("/"), "PROPERTY")


class SafeTarget(unittest.TestCase):
    """This service listens on a port, so a path from outside is a path to check."""

    def test_refuses_to_escape_the_media_root(self) -> None:
        for attempt in ("../../etc", "B12/../../..", "B12/../../../../tmp"):
            with self.assertRaises(ValueError, msg=f"{attempt!r} was allowed out"):
                app.safe_target(attempt)

    def test_an_absolute_path_is_read_as_relative_to_the_media_root(self) -> None:
        """`/etc/passwd` means `<media root>/etc/passwd`, which is nowhere.

        The leading slash is stripped before resolving, so a caller cannot name
        a file on the host by typing an absolute path. Worth pinning down: it
        looks like an escape and is the opposite of one, and a later
        simplification that stopped stripping the slash would be a real hole
        with no test standing in front of it.
        """
        inside = app.safe_target("/etc/passwd")
        self.assertTrue(
            inside == app.MEDIA_ROOT or app.MEDIA_ROOT in inside.parents,
            f"{inside} escaped the media root",
        )

    def test_allows_an_ordinary_property_folder(self) -> None:
        self.assertTrue(str(app.safe_target("B12-4bhk")).endswith("B12-4bhk"))


class KnownSteps(unittest.TestCase):
    """n8n sends the step list, so the two have to agree on the names."""

    def test_every_default_step_is_one_the_worker_knows(self) -> None:
        for step in app.DEFAULT_STEPS:
            self.assertIn(step, app.PROPERTY_STEPS, f"'{step}' is not a step this worker has")

    def test_every_step_maps_to_a_real_script(self) -> None:
        for step, (job, _suffix, _args) in app.PROPERTY_STEPS.items():
            self.assertIn(job, app.JOBS, f"step '{step}' points at unknown job '{job}'")
            script = app.SCRIPTS / app.JOBS[job]
            self.assertTrue(script.is_file(), f"step '{step}' needs {script.name}, which is missing")


if __name__ == "__main__":
    unittest.main(verbosity=2)
