<!--
Thanks for contributing to slimdoc.

Every change reaches main through a pull request — main is protected and cannot
be pushed to directly. See CONTRIBUTING.md for the full flow.
-->

## What this changes

<!-- One or two sentences. What behaviour is different after this merges? -->

Closes #

## Why

<!-- The problem this solves. Link the issue if the discussion happened there. -->

## How it was verified

<!-- Tests added, fixtures used, commands run. "npm test passes" alone is rarely enough
     for a behaviour change — say what new case is covered. -->

- [ ] `npm test` passes locally
- [ ] Added or updated tests covering this change
- [ ] Updated `README.md` if the CLI flags or public API changed

## Release

<!--
Publishing is automatic: if package.json's version is higher than what's on npm when
this merges, CI publishes it, tags the commit and cuts a GitHub Release.

Tick ONE.
-->

- [ ] **No release** — version left unchanged; this rides along with a later release
- [ ] **Release this** — version bumped in `package.json` (patch / minor / major, per semver)

<!-- If releasing, note the user-visible change here so the release notes read well. -->
