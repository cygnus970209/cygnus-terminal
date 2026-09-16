<div align="center">
  <img src="src-tauri/icons/128x128.png" width="72" alt="Cygnus Terminal icon" />
  <h1>Cygnus Terminal</h1>
  <p><strong>Connect to servers, move files, and remember your workflow.</strong></p>
  <p>Rust · Tauri 2 · SSH · Telnet · Serial · SFTP · Credential Vault</p>
  <p><a href="README.md">한국어</a> · <strong>English</strong></p>
  <p><a href="https://github.com/cygnus970209/cygnus-terminal/releases/latest">Download</a> · <a href="#features">Features</a> · <a href="#roadmap">Roadmap</a> · <a href="CHANGELOG.md">Changelog</a></p>
</div>

![Terminal workspace with server history and the SFTP file sidebar](docs/media/workspace.png)

Cygnus is a desktop terminal for people working across servers and network equipment. Keep connections, per-server command history, saved commands, paths, and credentials in one place.

**A Rust backend and Tauri's system WebView** keep the architecture lightweight without bundling a separate Chromium runtime. Cygnus is designed to reduce memory overhead; actual usage depends on the OS, open sessions, and workload. No comparative memory benchmark is claimed here.

> Screenshots show the current UI with synthetic demo servers, files, and credential metadata.

## Features

| Your task | What Cygnus provides |
| --- | --- |
| Connect to servers and devices | SSH, Telnet, Serial, and local shells in one tabbed workspace |
| Reconnect quickly | Saved connections, reusable groups, favorites, search, and filters |
| Enter credentials | Encrypted Vault, server mappings, and credential selection at SSH prompts |
| Manage files | Dedicated SFTP window, local/remote panels, server-to-server transfers, and transfer progress |
| Repeat commands | Per-SSH-server history, command/path bookmarks, and shared snippets |
| Inspect operations | CPU, memory and disk monitoring, multiple log streams, and SSH local forwarding |

## Start with organized connections

![Connections page with SSH, Telnet, and Serial profiles](docs/media/connections.png)

- **SSH**: password/key authentication, Jump Host, Agent Forwarding, and host-key verification.
- **Telnet**: access legacy servers and network equipment.
- **Serial**: save COM/TTY paths and baud rates, even before a device is plugged in.
- **Local Shell**: open a local terminal tab when you need one.

Once a group is saved with a connection, select it from the list next time. Use protocol/group filters and favorites to find a connection, then choose **Save** or **Save & Connect**.

## A Vault that knows your servers

![Vault items mapped to servers](docs/media/vault.png)

Choose the right credential for a server instead of copying passwords into your terminal.

- Manage passwords, SSH key passphrases, SSH keys, and PAT username/token entries.
- Link a credential to multiple servers and control its scope.
- Detect SSH `sudo`, password, and passphrase prompts and offer matching credentials. Prompt patterns are configurable.
- Local secret values use **AES-256-GCM encryption**, with the master key managed through the operating system's credential store.
- **Vault injection decrypts in Rust and writes directly to the SSH channel.** That operation does not return the decrypted password to the UI or copy it to the clipboard.

Secret injection currently supports SSH and locally stored Cygnus items. External password-manager integration is not advertised as a shipped capability.

## Give file transfers their own workspace

![SFTP workspace with remote and local file panels](docs/media/sftp.png)

Click **SFTP Files** above the terminal to open the right-hand file panel. Its visible **Open SFTP window** button takes you directly to a larger file workspace.

- Choose local storage or a remote server on either side, including **server-to-server transfers**.
- Drag and drop, multi-select, upload/download, rename, and create folders.
- Track progress and speed, cancel transfers, and resolve filename conflicts with Replace, Skip, or Keep Both.
- Compare and synchronize local/remote folders with a preview before execution.
- Open remote files in a local editor and automatically upload saved changes.

## Keep each server's working context

For saved SSH connections, the left-hand **Server tools** panel keeps frequent tasks close:

- **History**: search past commands, run them again, or save them to Commands.
- **Commands**: bookmark health checks, restarts, and deployment commands.
- **Paths**: bookmark frequently used directories.
- **Ports**: manage SSH local port forwarding.

Shared **Snippets**, a `⌘/Ctrl K` command palette, and resizable panels reduce repetitive work. Automatic directory tracking runs **only when a shell sends OSC 7 directory information**; Cygnus never inserts `pwd` into your session.

Monitoring and log viewing use separate SSH channels. Check server resources and multiple log streams while continuing your terminal work.

## Install

Download an installer from the [latest release](https://github.com/cygnus970209/cygnus-terminal/releases/latest).

| Platform | Distribution |
| --- | --- |
| macOS · Apple Silicon | `.dmg`, Developer ID signed and notarized |
| Windows · x64 | `.msi` or `.exe`, currently without Windows code signing |

Installed apps check GitHub Releases for updates. Linux and Intel Mac installers are not part of the current release matrix.

Export/import connections and command/path bookmarks as JSON. This is not a full backup: passwords, Vault items, and snippets are not included.

## Roadmap

**Next: advanced operations across multiple servers.**

We plan Ansible-style workflows for running commands, applying configuration changes, and deploying to server groups, with per-server results. These capabilities are not included in the current version; scope and timing will be announced later.

## Development

Tauri 2 connects a React, TypeScript, and xterm.js frontend to the Rust backend. Application data is stored locally in SQLite.

Use Rust stable, Node.js 22.12+ or Bun, and the platform-specific Tauri build prerequisites.

```sh
bun install --frozen-lockfile
bun run tauri dev

# Validate
bun run build
bun run test
cargo test --manifest-path src-tauri/Cargo.toml

# Build installers
bun run tauri build
```

Report bugs and suggest features through [Issues](https://github.com/cygnus970209/cygnus-terminal/issues).

[MIT License](LICENSE)
