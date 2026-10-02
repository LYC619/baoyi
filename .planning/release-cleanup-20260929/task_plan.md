# Release cleanup - 2026-09-29

## Goal
Publish the working application under release, document version history, and
organize obsolete/process files without losing user data or existing changes.

## Phases
1. Inventory releases, process outputs, data, Git history and running apps: complete
2. Establish current version and build a verified release: complete
3. Reversibly archive historical packages and process files: complete
4. Verify release, file moves and documentation: complete

## Safety
- Work serially; preserve the existing dirty worktree.
- Never move the running pica-network-verification package.
- Preserve AppData, local libraries, downloads, references and recovery snapshots.
- Validate absolute workspace boundaries before any recursive move/delete.
- Prefer reversible moves and record old/new locations.

## Errors
- PowerShell does not expand wildcard path arguments to rg; use directory searches and --glob.
- Release-config regression first run: 4 expected failures (lockfile version drift,
  missing portable inheritance, colliding green output, hardcoded build command).
- Initial archive tool lookup used an absent 7zip-bin path; compression was not needed.
- ASAR inspection initially normalized paths to '/', which its Windows API does not accept;
  keeping native separators resolved it. All 58 compiled files match the prior working package.
- A final diff experiment with core.autocrlf=false interpreted existing CRLF bytes as
  trailing whitespace. No files were changed; rerunning the repository's normal
  git diff --check passed. Preserve its existing line-ending policy.
