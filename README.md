# TheOpen Harness

English | [中文](README.zh.md)

TheOpen Harness (`toh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

TheOpen Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @buckeyestudio/toh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/dustinwloring1988/theopen-harness.git
cd theopen-harness
pnpm install
pnpm run build
pnpm toh web
```

`pnpm run build` prepares the repository artifacts. `pnpm toh web` uses those built artifacts without rebuilding.

### Desktop app

```sh
pnpm toh desktop
```

The desktop command opens one Electron window around the same Web UI: the window spawns and owns the web backend on a loopback port, so closing it stops the harness — no separate server or browser tab. A second launch focuses the existing window instead of starting another backend. The app needs the built checkout (`pnpm run build`) plus `node` on PATH.

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/dustinwloring1988/theopen-harness/discussions).
- Add the [`toh-plugin`](https://github.com/topics/toh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">TheOpen Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
