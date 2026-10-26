# Changelog

## [0.1.18] - 2026-10-26

### Added
- Connect MCP clients through **Beta** browser authorization and explicit approval in Cygnus. Compare the displayed code, review shared servers and permissions, and approve without copying a bearer token.
- Keep OAuth approvals across MCP restarts, renew client tokens automatically, and revoke individual clients from Settings. MCP still requires manual activation and the security acknowledgement each time it starts.
- Create RDP connections from **New connection → RDP (Beta)**, with Save and Save & Connect actions. Search, filter, favorite, connect, edit and delete saved RDP destinations in Connections and the sidebar.
- Add Copy / Paste context menus to regular and MCP terminals.

### Changed
- Search MCP servers by name, address, account, group or environment; filter groups or selected servers and select only the visible results.
- Default Codex, Claude Code, Cursor and Kiro setup to OAuth. Keep a manual-token option that copies directly usable commands or configuration without environment-variable placeholders.
- Remember the last MCP port, server selection and permissions. Saved OAuth grants remain limited to their approved servers and permissions when settings change.

### Fixed
- Restore terminal focus and clipboard shortcuts on macOS and Windows, including Korean keyboard layouts. Preserve multiline paste handling and discard delayed clipboard reads after tab, job or window-focus changes.
- Keep RDP favorites separate from SSH profiles with the same numeric ID, and preserve open sessions when deleting saved destinations.
- Handle the default HTTP port correctly during MCP OAuth requests while retaining exact local Host checks.
- Reject cross-site browser requests to OAuth approval pages when browser request metadata is available, reducing unwanted approval prompts.

### Known limitations
- OAuth client integration and Windows/IIS/RDP features remain **Beta**. Automated browser fixtures and official MCP SDK interoperability pass; installed Codex/Claude/Cursor/Kiro browser return, native OS clipboard behavior and real Windows-server interoperability still need broader validation.
- When switching an existing MCP registration to OAuth, remove its static Authorization header and register it again using the setup shown in Settings. Keep the same MCP port to reuse saved authorizations.

## [0.1.17] - 2026-10-26

### Added
- Show the Vault picker for password prompts in MCP terminals. Choose a saved credential, submit a masked one-time password without saving it, or dismiss the picker and type directly. Open it manually with **Password / Vault** for custom prompts.
- Save server OS and shell preferences, detect the connected environment, and show Windows CPU, memory, disk, process and event information over SSH with PowerShell.
- Add **Beta** read-only IIS tools for sites, application pools, bindings, recent events and bounded log previews.
- Add **Beta** embedded RDP sessions with saved connection profiles, certificate fingerprint confirmation, keyboard and mouse input, short Unicode text input, DPI selection, reconnect and server-supported live resolution changes.
- Add opt-in RDP text clipboard exchange with explicit previews and send/copy actions. Sharing defaults to off and stops when the panel closes, the tab changes or the app loses focus; file, image and automatic clipboard synchronization are not supported.

### Changed
- Verify OS and shell capabilities before using Windows or Linux server tools. Include server environment settings and RDP profile metadata in connection backups without exporting credentials or certificate trust.
- Keep MCP Vault decryption in the backend and apply the same output protection as manual typing: entered secrets and subsequent output are excluded from AI results and execution history.

### Fixed
- Restore keyboard focus when switching to a running MCP terminal. Discard password drafts when leaving a tab or finishing a job, and prevent stale input from reaching a reused tab's next job.
- Limit RDP dynamic channel negotiation to supported protocol versions so servers do not send unsupported compressed channel messages.

### Known limitations
- Windows monitoring, IIS and embedded RDP remain **Beta**. Automated fixtures and local protocol integration tests pass; real Windows server policies, native IME and installed-app interoperability still need broader validation. WinRM/PSRP and IIS configuration changes are not included.

## [0.1.16] - 2026-10-12

### Added
- Open dedicated interactive MCP terminals for command execution, reusing completed tabs per server while keeping concurrent commands in separate tabs. Preserve prior output and the user's current input focus.
- Allow local keyboard input and cancellation from MCP terminals. Wait for the local monitor before connecting and require the SSH server to accept a PTY.

### Changed
- Require explicit acknowledgement of the MCP security and privacy notice for every activation, enforced in both Settings and the backend.
- Keep manual terminal input and subsequent output out of MCP results and execution history, including secrets echoed by the server in output or failure metadata.

### Fixed
- Keep Settings open when a text selection or scrollbar drag ends outside the dialog.
- Prevent delayed input errors or clipboard reads from affecting the next command when an MCP tab is reused.

## [0.1.15] - 2026-10-12

### Added
- Connect Codex CLI, Claude Code, Cursor and Kiro to an opt-in, authenticated local MCP server with explicitly shared SSH profiles, command execution, job results and cancellation.
- Use seven SFTP MCP tools for directory listings, metadata, bounded file reads and writes, directory creation, renaming and nonrecursive deletion, with separate read/change permissions that default to off.
- Drag terminal tabs to reorder them, pin tabs with F10, and use the context menu to close other tabs or tabs to the left/right. Pinned tabs survive bulk closing and can still be closed directly.
- Copy full commands from server history and clear the current server's entire history after confirmation, including entries hidden by search.

### Changed
- Make SSH execution history opt-in on new installations, with configurable retention, bounded temporary results, explicit deletion and restricted database file permissions on macOS/Linux. Existing recorded jobs migrate to seven-day retention.
- Keep Connections in the sidebar and command palette while reserving the tab strip for sessions and retaining a single sidebar toggle.

### Fixed
- Show full commands in history tooltips and avoid recording bare shell prompts or stripping command redirections and comments.
- Close connections that finish opening after their terminal tab has closed, and release stalled automation connections and pending MCP requests on cancellation.
- Preserve trusted host-key verification and credential consent for automation; prevent MCP clients from reading jobs outside their activation.

## [0.1.14] - 2026-09-29

### Added
- Experimental macOS import of Termius 10.1.0 local connections, including group defaults and identity references, with Keychain decryption, preview and duplicate detection. Passwords and private key contents are excluded.

### Fixed
- Show the keychain access explanation again whenever permission is denied, with explicit retry and cancel controls for both Cygnus credentials and Termius imports.
- Recognize Git HTTPS password prompts in the default Vault autofill rule, including existing installations, while preserving disabled and custom rules.

## [0.1.13] - 2026-09-29

### Added
- Import saved SSH connections from OpenSSH configuration and iTerm2 profiles, with preview, duplicate detection, per-connection group selection, and warnings for settings that need manual setup.
- Explain credential access before the first operating-system keychain request, with cancel/continue controls and macOS Always Allow guidance.

### Changed
- Redesigned the Vault library and terminal credential picker with search, type filters, linked-server context, and an inline editor and deletion confirmation.
- Defer keychain access until credentials are needed; browsing saved connections and Vault metadata no longer requests keychain access at startup.
- Use the personal application identifier `io.github.cygnus970209.cygnus-terminal`. Existing database contents and the original encryption key migrate without deleting the legacy copies. WebView-only preferences may need to be configured again.
- Keep Settings at a consistent size when switching tabs.

### Fixed
- Resolve iTerm2 SSH destinations from the active command or startup text instead of treating a profile's display name as a hostname.
- Allow connections with relative key paths to be imported for later editing while continuing to skip duplicates.
- Prevent credential-picker keyboard actions from leaking into the terminal or injecting a secret twice.

## [0.1.12] - 2026-09-28

### Fixed
- Terminal input and saved commands convert non-breaking spaces to regular spaces, preventing visually correct commands such as `sudo su` from failing with `command not found`.
- Hidden terminals retain their dimensions, and restored windows recalculate and redraw after layout settles to prevent narrow prompt wrapping.
- New sessions receive the current terminal dimensions even when layout finishes before connection setup.
- Serial sessions no longer send unsupported PTY resize requests.

## [0.1.11] - 2026-09-16

### Added
- Connections start page with saved SSH, Telnet, and Serial profiles, protocol/group filters, and favorites.
- Reusable group selection and separate Save / Save & Connect actions.
- Korean and English feature guides with screenshots and a multi-server automation roadmap.

### Changed
- Charcoal workspace with horizontal session tabs, compact terminal chrome, and resizable side panels.
- Shared custom dropdowns with keyboard navigation and viewport-aware placement.
- Left-side server tools for history, saved commands, paths, and ports.
- Redesigned SFTP workspace and an explicit Open SFTP window action in the file sidebar.
- Automatic directory tracking uses OSC 7 only; no injected pwd commands.
- Connection backups include protocol and serial baud rate, while retaining legacy SSH import support.

### Fixed
- Saved SSH authentication is retained when editing and connecting.
- Failed connection saves keep the editor open without starting a session.
- SFTP selection updates toolbar actions immediately.
- Directory updates respect the active tab and current Follow setting.
