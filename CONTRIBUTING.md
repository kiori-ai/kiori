# Contributing to Kiori

Thank you for wanting to help. Right now the most useful things are bug reports, questions and ideas: open an [issue](https://github.com/kiori-ai/kiori/issues), or write to [help@kiori.io](mailto:help@kiori.io).

## Pull requests

Kiori's server is free for non-commercial use and sold under commercial licenses (see [License](README.md#-license)). To merge outside code, we need a contributor license agreement that allows both, and it isn't ready yet. Until it is, please open an issue before you write code, so your work doesn't get stuck. The same goes for the SDKs and the SillyTavern extension, so there's one way in.

## Working on Kiori

- You need Node.js 22.13 or newer, and nothing else: Kiori has no dependencies, and we'd like to keep it that way.
- `npm test` runs the tests. They use a fake model provider on your machine, so they need no key and spend nothing.
- `node bin/kiori.mjs serve` starts the API, the console and the docs on http://127.0.0.1:7700. Settings and commands are in [docs/self-hosting.md](docs/self-hosting.md).
- The docs pages on kiori.io are built from the markdown in [docs/](docs/). `node bin/kiori.mjs site` builds the whole static site into `dist/`.

## Security

Please don't report a security problem in an issue. See [SECURITY.md](SECURITY.md).
