# Installation documentation correction handoff

Status: **documentation-only handoff prepared; overall plugin acceptance remains incomplete.** Core implementation review and independent checks are not equivalent to full host integration acceptance. Real-host Web/browser end-to-end validation has not been completed; do not describe this documentation repair as deployment, release, or overall acceptance.

## Scope and baseline

- Repository: `magpie-plugin-session-date`.
- Branch: `feature/session-date-filter`.
- Requested baseline: `b151d317b7ef52f43fdf4d27829a0fa02205bba7`; initial HEAD matched this BASE.
- Only intended tracked change: `README.md`. New record: `.superpowers/sdd/session-date-filter/install-doc-fix/report.md`.
- Existing modifications to `progress.md` and `task-3-report.md`, and all pre-existing untracked evidence/log/database/fixture/package files, are outside scope and must remain untouched and unstaged.

## Evidence reviewed

1. `.superpowers/sdd/session-date-filter/task-3-final-acceptance/review.md`, especially lines 18, 53–65, 99–103, and 105–116:
   - The real CLI accepted a `.tgz` path and recorded it in isolated `plugins.json`, but path resolution treats it as a path and does not unpack the archive. Directory path installation and removal using the same exact path were the demonstrated working flow (add/list/loaded evidence in the report; remove exited 0 and returned isolated config to an empty list).
   - The prior README's direct tarball install and short-name removal were unsupported by those measurements. Do not infer that `session-date-filter` removes the folder-sourced plugin.
   - Existing actual package load evidence used Bun 1.3.10 and only covered the report's host/runtime setup. The host's default 1.4.2 path was not demonstrated end-to-end; server listener, actual gateway forwarding, Web page proxy, browser and lifecycle portions remain incomplete or blocked.
   - A future overall acceptance must repack from the new HEAD and inspect the newly generated tarball; prior archives are historical artifacts and must not be overwritten.
2. Reference host source checkout at `50265256ba56ac164a680da0689e1c6d90dac471`, read only:
   - `internal/plugin/bun.go:32-36,242-248`: default `BunVersion` is 1.4.2; `Bun()` uses a non-empty environment override directly, before managing/downloading its default Bun.
   - **The exact override variable is `MAGPIE_BUN`** (the source reads `os.Getenv("MAGPIE_BUN")` in this checkout). The name was extracted from the actual source string and verified by its ASCII codepoints (10 characters); it is not inferred from the earlier report. For a future controlled run, an override can be scoped to that one command, e.g. `MAGPIE_BUN=/path/to/compatible/bun magpie plugin list --json`; it does not alter the user's global environment/config. That is a source-based usage example, not a recommendation to install/download a runner in this documentation task.
   - `internal/plugin/store.go:382-393` (`Target`) returns a path spec as an absolute filesystem path; it does not extract an archive. `PackageName` at `1034-1050` reads package metadata from the target directory (or the parent of a file), which is consistent with treating a tarball file as a file path, not unpacking it.
   - `internal/plugin/gateway.go:21-45` distinguishes file target hook extensions from directory targets and reads `package.json` only for a directory. An archive file is not a plugin directory and is not a recognized hook file.
   - `internal/plugin/store.go:607-627,703-733`: `Remove` matches an exact stored spec or `Name(spec)`; `ShortName` only strips known prefixes such as `page-`, not `lobehub-plugin-`. The robust documented removal is therefore the exact absolute directory path used for add, not an assumed short name.
   - `internal/gui/pagebridge.js:16-22,132-140` provides the page service URL when opened through Web; `internal/gui/pageservice.go:17-34` describes its authenticated proxy. This confirms the Web page/service boundary. It does not establish that the request filter hook is unavailable in desktop mode; that remains untested.
3. Plugin project files read: current README, `package.json`, and the final acceptance report. No plugin runtime source was modified.

## Documentation changes

- Replaced the old acceptance-state sentence with: core review and independent acceptance are complete, while real-host Web/browser overall acceptance is incomplete; explicitly not deployed.
- Kept the existing filtering scope and accounting caveats. Clarified the page service is currently Web-mode-only due to the desktop bridge boundary, without making an unsupported claim about desktop hook availability.
- Replaced the direct `.tgz` installation with a paste-ready generic-path flow: requires archive file and previously nonexistent destination, creates the destination, extracts the archive (`package/` root), then passes the absolute `package` directory path to `plugin add`.
- Replaced unverified short-name uninstall with the identical directory `PLUGIN_SPEC` path. Explained how to recompute it after shell exit.
- Explicitly states archive registration is not extraction/loading; host `list`/loaded, hook, listener, page, and service proxy checks remain distinct. Existing load evidence is limited to the tested host/runtime recorded in the independent report.
- Added requirement to repack from the new HEAD for future final acceptance. No runtime changes, feature claims, or new environment requirements added.

## Verification log

Commands and results:

- `git status --short`, `git branch --show-current`, `git rev-parse HEAD`, `git merge-base HEAD b151d317b7ef52f43fdf4d27829a0fa02205bba7`: all exited 0; initial HEAD equalled requested BASE; branch was `feature/session-date-filter`; pre-existing dirty/untracked items were inventoried.
- `git -C <host repo> rev-parse HEAD`: exit 0; reference checkout was `50265256ba56ac164a680da0689e1c6d90dac471`.
- `git -C <host repo> show 50265256...:internal/plugin/bun.go` plus targeted `store.go`, `gateway.go`, `pagebridge.js` reads: exited 0; source review succeeded; exact override `MAGPIE_BUN` verified.
- Target existence check for `.superpowers/sdd/session-date-filter/install-doc-fix`: exit 0; target was absent before creating the report.
- Synthetic archive extraction/install command flow: extracted a temporary generated `package/` archive into a previously absent destination using the README's guard/order, then resolved the absolute `package` directory; smoke check exited 0. This verifies shell/path/archive-root logic only, not the host CLI, plugin loading, or real installation.
- `git diff --check`: exit 0 before commit.
- README assertions: exit 0; obsolete direct `.tgz` add, unverified `plugin rm session-date-filter`, and stale “本轮没有实际运行安装” statements are absent; required archive/directory variables, extraction, same-spec add/rm, incomplete Web/browser status, and desktop-bridge boundary are present.
- Precise staged-path and commit verification: this report and `README.md` are the only intended commit paths; final commit identity is recorded by `git log` and `review.patch`.

## Not verified / next acceptance boundary

- No plugin add/rm, host startup, Bun download/install, page load, Web proxy, browser, production installation, or real model call was run by this documentation fix.
- No assertion that the default host Bun 1.4.2 has loaded the package. The independent report's Bun 1.3.10 partial-load evidence is version-scoped and not generalized.
- The plugin overall remains not accepted as fully integrated. After this commit, the next final acceptance must create a fresh tarball from this HEAD and inspect the packaged README and runtime files, then continue real-host Web/browser acceptance in its separately authorized environment.

## Commit handoff

- Commit subject: `docs: correct local plugin installation and acceptance state`.
- Only `README.md` and `.superpowers/sdd/session-date-filter/install-doc-fix/report.md` are to be staged; pre-existing changes and untracked evidence remain untouched.
- The documentation commit's SHA and resulting HEAD are identified by the repository's `git log` after commit. `review.patch` is generated separately after commit, contains BASE..HEAD log/stat/full diff, and remains untracked/uncommitted.
