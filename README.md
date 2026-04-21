<p align="center">
  <img src="https://img.shields.io/badge/Tauri-2.0-blue?style=flat-square&logo=tauri" />
  <img src="https://img.shields.io/badge/Rust-1.75+-orange?style=flat-square&logo=rust" />
  <img src="https://img.shields.io/badge/React-19-61dafb?style=flat-square&logo=react" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" />
</p>

# Cygnus Terminal

**Server Cockpit** - A modern and simple SSH terminal client that remembers your servers.

Cygnus is not just another SSH client. It builds a persistent relationship with every server you connect to -- remembering your command history, bookmarked paths, frequently used snippets, and server health metrics. All in a lightweight ~30MB native binary.

## Motivation

I'm a backend developer who works with SSH daily. I kept thinking "this could be a bit more convenient" while switching between tools. Around the same time, I wanted to learn Rust -- so I combined the two and started building this as a side project. It's still rough around the edges, but it's been a great way to learn.

---

## Why Cygnus?

| Pain Point | Cygnus Solution |
|---|---|
| Switching between terminal, SFTP client, and monitoring tools | All-in-one: terminal + file manager + monitor |
| Forgetting commands you ran last week on a server | Per-server command history with search |
| Typing the same deploy commands repeatedly | Command bookmarks + snippet library |
| No idea if the server is healthy before running commands | Real-time CPU/RAM/Disk monitoring |
| Managing SSH tunnels via command line | Visual port forwarding manager |

## Features

### Core Terminal
- Multi-tab SSH & local shell sessions
- xterm.js with 256-color support and Catppuccin theme
- RSA-SHA2 / Ed25519 / ECDSA key authentication
- Jump Host (ProxyJump) support
- SSH Agent Forwarding
- Known Hosts verification

### Server Memory
- **Command History** -- auto-captured per server, searchable, tab-completion aware
- **Command Bookmarks** -- save frequently used commands per server
- **Path Bookmarks** -- one-click `cd` to saved directories
- **Snippet Library** -- global command templates with categories

### File Management
- **SFTP File Tree** -- browse remote files with breadcrumb navigation
- **Drag & Drop Upload** -- drop files onto the tree to upload
- **Download** -- right-click any file to save locally
- **cd Tracking** -- file tree follows your terminal directory changes

### Server Monitoring
- **Real-time Metrics** -- CPU, RAM, Disk usage with color-coded gauges
- **Load Average & Uptime** -- at a glance
- **Non-intrusive** -- runs on a separate SSH channel, no terminal interference

### Port Forwarding
- **Visual Manager** -- add/remove forwards with a click
- **Local Forward** -- `localhost:port` tunneled through SSH to remote
- **Live Status** -- see active/stopped state

### Multi-Tail Log Viewer
- Monitor multiple log files simultaneously
- Tabbed view with auto-scroll
- Separate SSH channels per log stream

### Data & Settings
- **AES-256-GCM Encryption** -- passwords secured with OS Keychain master key
- **Export/Import** -- backup profiles and bookmarks as JSON
- **Resizable Panels** -- drag to resize, collapse with one click

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Tauri 2.0 |
| Backend | Rust (russh, rusqlite, aes-gcm, keyring) |
| Frontend | React 19 + TypeScript |
| Terminal | xterm.js 6.0 |
| Database | SQLite (WAL mode, versioned migrations) |
| SFTP | russh-sftp |
| Build | Vite 7 |

## Architecture

```
+------------------------------------------+
|              React Frontend              |
|  TabBar | Terminal | FileTree | Monitor  |
+------------------+-----+-----------------+
                   | IPC |
+------------------+-----+-----------------+
|              Rust Backend                |
|  SSH  | PTY | SFTP | Monitor | Forward   |
|  DB (SQLite) | Crypto (AES+Keychain)     |
+------------------------------------------+
```

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) 1.75+
- [Node.js](https://nodejs.org/) 18+
- [Tauri CLI](https://tauri.app/start/)

### Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

### Project Structure

```
src/                          # React frontend
  types/                      # Shared TypeScript types
  components/
    terminal/                 # Terminal, MonitorBar, LogViewer
    connection/               # ConnectDialog, ConnectionsView, ServerContext
    files/                    # FileTree (SFTP)
    common/                   # TabBar, ResizablePanel, Settings
    snippets/                 # SnippetsView

src-tauri/                    # Rust backend
  src/
    commands/                 # Tauri IPC commands (pty, ssh, profile, services)
    ssh/                      # SSH connection manager
    db/                       # SQLite (profiles, history, bookmarks, snippets)
    sftp/                     # SFTP file operations
    monitor/                  # Server metrics collection
    forward/                  # Port forwarding
    tail/                     # Log file streaming
    crypto/                   # AES-256-GCM + OS Keychain
    pty/                      # Local shell (PTY)
```

## Roadmap

- [ ] UI/UX improvements
- [ ] AI Assistant (error log analysis, natural language to commands)
- [ ] SFTP enhancements (drag between servers, directory sync)
- [ ] Telnet protocol support
- [ ] Serial port (COM/TTY) support

## License

MIT
