# Changelog

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
