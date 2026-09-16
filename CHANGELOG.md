# Changelog

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
