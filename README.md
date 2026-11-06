# termenbox-ci

The build and release workflows of [Termenbox](https://termenbox.dev), a web terminal that keeps your sessions
alive across devices.

This repository holds automation only: GitHub Actions workflows, the small actions they share, and the webhook
Worker that starts them. The Termenbox code itself is not here. Most workflow files are generated from the
Termenbox source and are not edited in this repository.

## Where to get Termenbox

- Downloads, the installer and the documentation are on [termenbox.dev](https://termenbox.dev).
- Signed releases are published at [github.com/termenbox/termenbox](https://github.com/termenbox/termenbox) and on the
  download domain. Each release carries a signed manifest that the installer verifies.

## Questions and problems

Ask in the [product repository](https://github.com/termenbox/termenbox). Issues and discussions are switched off here.

To report a security problem, write to **security@termenbox.dev**. Please do not open a public issue for it.

## Attribution

Copyright (c) 2026 Sergei Strebulaev, doing business as Termenbox. The workflow files, shared actions and the Worker in this repository are
released under the MIT licence (see [LICENSE](LICENSE)).

The workflows call third-party actions, which keep their own licences (see [NOTICES](NOTICES)). Termenbox itself is
licensed separately, under the terms published with each release.
