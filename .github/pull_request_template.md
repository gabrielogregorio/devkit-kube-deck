## What changes

<!-- one or two lines: what the user notices -->

## Changelog

[...autoGenerate]

## Checklist

- [ ] `VERSION` bumped (merging into `main` creates the tag `vX.Y.Z` and the release)
- [ ] `./run-tests.sh` ends with `ALL GREEN` (`RUN_E2E=1` when the UI or the server changed)
- [ ] Server coverage still at 100% and the new code has tests in the same PR
- [ ] Still safe by design: no kubectl verb that writes, no route or command that deletes, scales or restarts, and the pod shell still asks first
- [ ] New UI text is English inside `t("…")` with its line in `PT_BR` in `ui/src/i18n.js`
- [ ] New tray text is English inside `tr()` with its line in `PT_BR` in `tray_icon.py`
- [ ] Changed an `/api/*` route or a `KD_*` variable? Updated `CLAUDE.md` and `README.md`
- [ ] Changed `pyproject.toml`? Ran `uv lock` and exported `requirements-dev.txt`
