# kubectl skyline

A `kubectl` plugin that shows your cluster as a 3D city in the browser.

- **Namespaces** are floor plates.
- **Workloads and pods** are glowing towers, with one layer per container.
- **Services and ingresses** float above the pods they route to.
- **Live events** spark from the objects they touch.

Click anything to see its relationships, YAML, events and logs.

It is read-only and listens on loopback only.

![kubectl skyline](docs/skyline.png)

## Install

The install script is the recommended way. It works on macOS and Linux.

```sh
curl -fsSL https://raw.githubusercontent.com/zdk/kubectl-skyline/main/install.sh | sh
```

It installs the latest release and verifies its checksum.

You can change what it does with two variables:

| Variable      | What it does              | Default                               |
| ------------- | ------------------------- | ------------------------------------- |
| `VERSION`     | Pin a release             | latest                                |
| `INSTALL_DIR` | Where the binary is saved | `/usr/local/bin`, else `~/.local/bin` |

Set them on `sh`, not on `curl`:

```sh
curl -fsSL https://raw.githubusercontent.com/zdk/kubectl-skyline/main/install.sh | VERSION=v0.1.4 sh
```

### Other ways to install

**Homebrew**

```sh
brew install zdk/tools/kubectl-skyline
```

**krew**, from the latest release manifest

```sh
kubectl krew install --manifest-url https://github.com/zdk/kubectl-skyline/releases/latest/download/skyline.yaml
```

**Go**

```sh
go install github.com/zdk/kubectl-skyline/cmd/kubectl-skyline@latest
```

## Run

```sh
kubectl skyline              # current context, all namespaces, opens the browser
kubectl skyline -n shop      # one namespace; --context and other kubectl flags work too
```

Drag to orbit, right-drag to pan, scroll to zoom, click to select, `/` to search, `f` to fit all.

## License

MIT. three.js is vendored under its own MIT license.
