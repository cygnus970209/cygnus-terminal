<p align="center">
  <img src="https://img.shields.io/badge/Tauri-2.0-blue?style=flat-square&logo=tauri" />
  <img src="https://img.shields.io/badge/Rust-1.75+-orange?style=flat-square&logo=rust" />
  <img src="https://img.shields.io/badge/React-19-61dafb?style=flat-square&logo=react" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" />
</p>

# Cygnus Terminal

**An all-in-one terminal for developers** — terminal, SFTP, monitoring, port forwarding, and a credential vault in a single window.

Cygnus handles SSH, Telnet, and Serial in one place, and remembers per-server command history, bookmarks, and snippets. Credentials live in an encrypted vault and auto-fill sudo/password prompts. Ships as a ~30MB native binary.

---

## Motivation

I'm a backend developer who lives in SSH sessions. Small frustrations piled up over the years, and around the same time I wanted to learn Rust, so I started this as a side project. Still rough around the edges, but it has been a great learning playground.

---

## ✨ Features

### 🖥 Multi-Protocol Terminal

Multiple protocols share the same tab bar. Jump between sessions with ⌘+number.

- **SSH** — RSA-SHA2 / Ed25519 / ECDSA key auth, Jump Host (ProxyJump), Agent Forwarding, Known Hosts verification
- **Telnet** — for legacy gear
- **Serial (COM/TTY)** — router and embedded debugging, baud rate presets (9600 to 921600)
- **Local PTY** — your system shell
- xterm.js based, 256-color, Catppuccin theme, native ⌘C/V clipboard

### 🧠 Server Memory

Each server keeps its own workflow context, so you don't lose what you ran last week on prod.

- **Command History** — auto-captured per server, searchable, prompt-pattern aware
- **Command Bookmarks** — save deploy/restart one-liners per server
- **Path Bookmarks** — one-click `cd` to saved directories
- **Snippet Library** — global templates with categories

### 📂 SFTP — Dual-Panel File Manager

Pops out into its own window with a dual-panel layout. Either side can host local or remote, and dragging moves files across.

- **Dual Panel** — local↔local, remote↔remote, local↔remote, and **server↔server** transfers
- **Drag & Drop** — Finder ↔ panel both ways, panel ↔ panel both ways
- **Context Menu** — right-click for upload, download, rename, delete; multi-select supported
- **Transfer Dock** — progress, throughput, and a cancel button per job
- **Conflict Dialog** — Keep Both / Replace / Skip on name clashes, decided per file when transferring folders
- **Folder Sync** — local↔remote synchronization with a diff preview before execution
- **Local Editor Integration** — open a remote file in your local editor; saving auto-uploads via a file watcher

### 📊 Server Monitor

Glance at server health before you run commands. Runs on a dedicated SSH channel so the terminal stays untouched.

- **Real-time Metrics** — CPU, RAM, Disk usage with color-coded gauges
- **Load Average / Uptime** — at a glance
- Toggle from the StatusBar drawer (⌘1)

### 🔀 Port Forwarding

Visual manager for SSH tunnels.

- **Local Forward** — `localhost:port` routed through SSH to a remote service
- **Live Status** — active / stopped indicator

### 📜 Multi-Tail Log Viewer

Stream multiple log files side by side. Each log gets its own SSH channel.

- Per-tab auto-scroll
- Lives in the StatusBar drawer Logs tab (⌘3)

### ⚡ Workflow & UX

- **Command Palette** (⌘K) — switch tabs, connect profiles, fire snippets, search command history from one input
- **macOS Menu Integration** — toggle Server Context, File Tree, and drawer panels from the View menu
- **Resizable Panels** — drag to resize, one click to collapse
- **Cygnus Blue** design system — Catppuccin Mocha base with a developer-cockpit feel

### 🔑 Credential Vault

A built-in secrets store that maps credentials to servers and auto-fills prompts, so you stop pasting passwords into the terminal.

- **Item types** — Password, SSH key passphrase, raw SSH key, and Personal Access Token (username / password pair)
- **Sources** — store locally (encrypted with the master key) or reference an external manager: **1Password** (`op`) and **Bitwarden** (`bw`)
- **Server mapping** — link an item to one or more profiles, with `local` / `global` scope
- **Prompt auto-fill** — detects `sudo` / password / passphrase prompts in the terminal and offers the matching credential; detection patterns are editable in Settings
- **Plaintext never reaches the frontend** — a single backend call decrypts and injects straight into the SSH channel's stdin, so secrets stay out of the UI layer

### 🔐 Security & Sync

- **AES-256-GCM** master key stored in the OS Keychain (macOS Keychain / Windows Credential Manager), zeroized in memory on drop
- **Encrypted at rest** — profile passwords and Jump Host configs (which can carry a password) are encrypted in SQLite, never stored as plaintext
- **Export / Import** — back up profiles, bookmarks, and snippets as JSON
- **Auto Update** — when a new release lands on GitHub, the app surfaces it and replaces itself in place

---

## 🛠 Tech Stack

| Layer | Technology |
|---|---|
| Framework | Tauri 2.0 (WKWebView / WebView2) |
| Backend | Rust — `russh`, `russh-sftp`, `rusqlite`, `aes-gcm`, `keyring`, `serialport` |
| Frontend | React 19 + TypeScript 5.8 |
| Terminal | xterm.js 6.0 |
| Database | SQLite (WAL mode, versioned migrations) |
| Build / Release | Vite 8, GitHub Actions, Tauri Updater (minisign) |

## 🏗 Architecture

```
+------------------------------------------+
|              React Frontend              |
|  TabBar | Terminal | SFTP popout |       |
|  CommandPalette | StatusBar drawer       |
+------------------+-----+-----------------+
                   | IPC |
+------------------+-----+-----------------+
|              Rust Backend                |
|  PTY | SSH | Telnet | Serial | SFTP      |
|  Monitor | Forward | Tail | Watcher      |
|  Sync | Transfer Queue | Vault (inject)   |
|  DB (SQLite) | Crypto (AES + Keychain)   |
+------------------------------------------+
```

---

## 🚀 Getting Started

### Users (download a binary)

Grab the installer for your OS from [Releases](https://github.com/cygnus970209/cygnus-terminal/releases/latest).

- macOS (Apple Silicon): `.dmg` or `.app.tar.gz`
- Windows (x64): `.msi` or `.exe`

> If macOS blocks the first launch as a "damaged" file:
> ```bash
> xattr -rd com.apple.quarantine /Applications/cygnus-terminal.app
> ```

### Development

#### Prerequisites

- [Rust](https://rustup.rs/) 1.75+
- [Node.js](https://nodejs.org/) 18+ (or [Bun](https://bun.sh/))

#### Run

```bash
# Install dependencies
npm install   # or: bun install

# Run in development mode
npm run tauri dev

# Production build
npm run tauri build
```

---

## 📁 Project Structure

```
src/                          # React frontend
  components/
    terminal/                 # xterm + session handlers
    sftp/                     # SftpView, FilePanel, ConflictDialog
    files/                    # FileTree (in-app sidebar)
    connection/               # ConnectDialog, ServerContext
    vault/                    # VaultView, VaultPromptPicker (credential store + prompt auto-fill)
    common/                   # CommandPalette, StatusBar, UpdateBanner, SettingsDialog ...
    snippets/                 # SnippetsView (surfaced via Command Palette)

src-tauri/                    # Rust backend
  src/
    commands/                 # Tauri IPC commands
    ssh/  telnet/  serial/    # protocol session managers
    pty/                      # local shell
    sftp/                     # SFTP handles + directory ops
    transfer/                 # chunked upload/download queue
    sync/                     # local↔remote folder diff (compute_diff)
    monitor/                  # CPU/RAM/Disk collector
    forward/                  # port forwarding
    tail/                     # log file streaming
    watcher/                  # local file watcher → auto-upload
    vault/                    # credential store + decrypt-and-inject to SSH stdin
    crypto/                   # AES-256-GCM + OS Keychain
    db/                       # SQLite + migrations
```

---

## 🗺 Roadmap

**Recently shipped**
- ✓ Credential Vault — local-encrypted secrets, 1Password / Bitwarden references, server mapping, and sudo/password prompt auto-fill
- ✓ Telnet protocol
- ✓ Serial port (COM/TTY)
- ✓ SFTP dual panel + Transfer Dock + Conflict Dialog
- ✓ Folder sync (local↔remote with diff preview)
- ✓ Auto-updater + GitHub Releases CI
- ✓ Command Palette (⌘K)
- ✓ Local editor integration with file-watcher auto-upload

**Next up**
- [ ] Apple code signing & notarization
- [ ] Linux build (.deb / AppImage)
- [ ] Persistent background port forwarding
- [ ] AI assistant — error log analysis, natural language to commands
- [ ] Team-shared profile vault (E2E encrypted, git-backed)

---

## License

MIT
