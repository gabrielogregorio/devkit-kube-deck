"""tray_icon.py without GTK: icons, port and process checks, texts, i18n catalog and --install.
Standard library only (unittest), like the rest of this folder:  .venv/bin/python -m pytest tests/test_tray_icon.py"""
import contextlib
import io
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import tray_icon as tray  # noqa: E402

TR_CALL = re.compile(r'\btr\(\s*"((?:[^"\\]|\\.)*)"')
PLACEHOLDER = re.compile(r"\{(\w+)\}")


class TrayIconTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        # texts asserted in English whatever the machine's language; cache and desktop files in tmp
        for target, value in (("LANG", "en"), ("CACHE", str(self.tmp / "cache")),
                              ("ICONS", str(self.tmp / "cache" / "icons"))):
            patcher = mock.patch.object(tray, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        env = mock.patch.dict(os.environ, {"HOME": str(self.tmp), "XDG_DATA_HOME": str(self.tmp / "data"),
                                           "XDG_CONFIG_HOME": str(self.tmp / "config")})
        env.start()
        self.addCleanup(env.stop)

    def test_icons_on_and_off(self):
        tray.write_icons(str(self.tmp))
        on = (self.tmp / f"{tray.APP['slug']}-on.svg").read_text()
        off = (self.tmp / f"{tray.APP['slug']}-off.svg").read_text()
        self.assertTrue(on.startswith("<svg") and tray.APP["color"] in on)
        self.assertTrue(tray.APP["color"] not in off and "#9a9a9a" in off)

    def test_parse_ss_takes_every_pid(self):
        out = ('LISTEN 0 128 127.0.0.1:8899 0.0.0.0:* users:(("python3",pid=4242,fd=5),("python3",pid=4243,fd=5))\n')
        self.assertEqual(tray.parse_ss(out), [4242, 4243])
        self.assertEqual(tray.parse_ss(""), [])

    def test_belongs_by_cwd_or_command_line(self):
        proc, app, other = self.tmp / "proc", self.tmp / "app", self.tmp / "other"
        app.mkdir()
        other.mkdir()
        for pid, cwd, cmd in ((1, app, b"python3\0x.py"), (2, other, b"bash\0" + str(app).encode() + b"/run.sh"),
                              (3, other, b"python3\0y.py")):
            (proc / str(pid)).mkdir(parents=True)
            os.symlink(cwd, proc / str(pid) / "cwd")
            (proc / str(pid) / "cmdline").write_bytes(cmd)
        self.assertTrue(tray.belongs(1, str(app), str(proc)))
        self.assertTrue(tray.belongs(2, str(app), str(proc)))
        self.assertFalse(tray.belongs(3, str(app), str(proc)))
        self.assertFalse(tray.belongs(99, str(app), str(proc)))

    def test_status_texts(self):
        name, port = f"{tray.APP['name']} ({tray.APP['about']})", tray.APP["port"]
        self.assertEqual(tray.status_text(True, False), f"{name}: on air (port {port})")
        self.assertEqual(tray.status_text(False, True), f"{name}: starting…")
        self.assertEqual(tray.status_text(False, False), f"{name}: off")

    def test_failure_note_prefers_the_log(self):
        log = self.tmp / "server.log"
        log.write_text("starting\n\nError: port already in use\n\n")
        self.assertEqual(tray.last_log_line(str(log)), "Error: port already in use")
        self.assertEqual(tray.last_log_line(str(self.tmp / "missing.log")), "")
        self.assertEqual(tray.failure_note(1, "boom"), "boom")
        self.assertEqual(tray.failure_note(2, ""), "exited with code 2; see the log")

    def test_local_only_app_has_no_lan_address(self):
        self.assertIsNone(tray.APP["lan"])  # Kube Deck listens on 127.0.0.1 only
        self.assertEqual(tray.lan_ip().count("."), 3)

    def test_every_string_has_a_pt_br_line(self):
        used = set(TR_CALL.findall((ROOT / "tray_icon.py").read_text(encoding="utf-8"))) | {tray.APP["about"]}
        self.assertEqual(used - set(tray.PT_BR), set(), "add these to PT_BR in tray_icon.py")
        self.assertEqual(set(tray.PT_BR) - used, set(), "no longer used, remove from PT_BR in tray_icon.py")
        for en, pt in tray.PT_BR.items():
            self.assertEqual(set(PLACEHOLDER.findall(en)), set(PLACEHOLDER.findall(pt)), en)

    def test_language(self):
        self.assertEqual(tray.detect_language({}), "en")
        self.assertEqual(tray.detect_language({"LANG": "pt_BR.UTF-8"}), "pt-BR")
        self.assertEqual(tray.detect_language({tray.APP["lang_env"]: "en", "LANG": "pt_BR.UTF-8"}), "en")
        self.assertEqual(tray.tr("On", lang="pt-BR"), "Ligado")
        self.assertEqual(tray.tr(tray.APP["about"], lang="pt-BR"), "clusters Kubernetes, seguro por padrão")

    def test_install_and_remove(self):
        apps, auto = tray.desktop_paths()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(tray.main(["--install"]), 0)
        for path in (apps, auto):
            self.assertIn(f"Exec=/usr/bin/python3 {ROOT}/tray_icon.py\n", Path(path).read_text())
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(tray.main(["--remove"]), 0)
        self.assertFalse(os.path.exists(apps) or os.path.exists(auto))
        self.assertIn("removed", out.getvalue())

    def test_one_icon_per_app(self):
        first = tray.single_instance()
        self.assertIsNotNone(first)
        self.assertIsNone(tray.single_instance())
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(tray.main([]), 0)  # a 2nd run exits without touching GTK
        self.assertIn("already on the bar", out.getvalue())
        first.close()


if __name__ == "__main__":
    unittest.main(verbosity=1)
