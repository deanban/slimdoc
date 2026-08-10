# Contributing to slimdoc

`main` is protected. Nobody — including maintainers — pushes to it directly.
Every change arrives as a pull request, CI has to be green, and a review has to
approve it. Publishing to npm then happens automatically from `main`.

## The flow

1. **Open an issue first.** Use [Bug report](https://github.com/deanban/slimdoc/issues/new?template=bug_report.yml)
   or [Feature request](https://github.com/deanban/slimdoc/issues/new?template=feature_request.yml).
   For a bug, the most valuable thing you can attach is a small input file that
   reproduces it. For a feature, agreeing on the flag name up front saves a
   round of review.

2. **Branch off `main`.** Name it after what it does:

   ```
   feat/xlsx-extraction
   fix/pdf-header-detection
   docs/readme-flags
   chore/bump-typescript
   ```

3. **Work, with tests.** See [Local development](#local-development).

4. **Open a PR against `main`.** Fill in the template — in particular, say
   whether the PR should trigger a release.

5. **Get CI green and get a review.** Both are required to merge.

6. **Squash and merge.** The PR title becomes the commit message on `main`,
   so write it as one, e.g. `feat: extract text from .xlsx workbooks`.

## Local development

Requires Node 22 or newer.

```bash
git clone git@github.com:deanban/slimdoc.git
cd slimdoc
npm ci

npm run build          # tsc -> dist/
npm test               # build, then run the whole suite
node --test test/extract-pdf.test.js   # one file, without rebuilding
```

Tests are Node's built-in runner — no framework to learn. Fixtures live in
`test/fixtures/`; the generators for the binary ones are the `make-*.py`
scripts beside them. Keep new fixtures small and free of anything you wouldn't
publish: they end up in a public repo. Personal sample documents belong in
`test/fixtures/local/`, which is gitignored.

`dist/` is a build artifact. It is gitignored and never committed — CI builds it
fresh for both testing and publishing.

## What CI checks

Every PR runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml):

| Job | What it does |
| --- | --- |
| `test (node 22)` / `test (node 24)` | Build and run the full suite on the minimum supported Node and the current one. |
| `package` | `npm pack --dry-run`, then install the resulting tarball into an empty project and check that both the `slimdoc` CLI and the library entry point work. Catches a broken `files` list or `bin` path before it reaches npm. |

## Releasing

Releases are cut by CI. There is no manual `npm publish`, and no npm token
stored anywhere in this repo — the workflow authenticates through GitHub OIDC
(npm trusted publishing), which also attaches a provenance attestation proving
the tarball was built from this repo's source.

**To release, bump `version` in `package.json` inside your PR.** When it merges:

```
merge to main
  └─ .github/workflows/release.yml
       ├─ is package.json's version already on npm?
       │    yes → stop, nothing to do
       │    no  ↓
       ├─ build + test
       ├─ npm publish       (OIDC, with provenance)
       ├─ git tag v<version>
       └─ create the GitHub Release, notes generated from merged PRs
```

Merging a PR that does not change the version is a no-op for the release
workflow. That is the normal case — batch several PRs, then bump the version in
the last one (or in a small release-only PR).

Version numbers follow semver:

- **patch** (`0.2.0` → `0.2.1`) — bug fix, no behaviour change for correct input
- **minor** (`0.2.0` → `0.3.0`) — new flag, new format, new export
- **major** (`0.2.0` → `1.0.0`) — a flag or export changed meaning or went away

Because release notes are generated from merged PR titles, a clear title is
what the changelog will say.

### If a release fails halfway

The publish job tags only after npm accepts the package, so the usual failure
leaves nothing behind and re-running the job is safe. If a tag exists but the
version is not on npm, the workflow will refuse to run and say so — delete the
stray tag or bump to the next version.

## Code style

There is no linter or formatter in the repo; match the surrounding code. The
existing style is fairly consistent: TypeScript with explicit exported types,
ES modules with `.js` import specifiers, and comments reserved for explaining
*why* something is the way it is rather than restating the code.
