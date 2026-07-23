# Changelog

## AgentDock v0.1.1 — Windows

AgentDock v0.1.1 is a major usability and Windows portability improvement.

### Windows portability fix

This release fixes a Windows-specific `SPAWN EINVAL` error that could prevent Claude Code, Codex, or other agents from launching on computers where the CLI was installed as an npm-generated `.cmd` shim.

AgentDock now safely resolves and launches Windows `.cmd`, `.bat`, and `.exe` commands without unsafe shell-string concatenation.

The fix was manually tested on a separate Windows computer where the previous release failed, and agent launching now works correctly.

### New

- Lightweight toggleable workspace file explorer
- Lazy folder expansion
- Automatic file-tree refreshing
- Text and source-code previews
- Image previews
- Optional file-preview panel
- Preview disabled by default
- Persistent preview preference
- File importing into the active workspace
- Rename, replace, skip, and cancel options for import conflicts
- Right-click file and folder context menus
- Open files and folders in Visual Studio Code
- Reveal files in File Explorer
- Copy workspace-relative and full file paths
- Support for attachments beyond images
- Workspace-path fallback for files unsupported by an agent CLI
- Copyable agent-launch diagnostics
- Settings action to reset agent detection and custom executable paths
- Settings action to remove projects whose folders no longer exist

### Improved

- Safe Windows `.cmd`, `.bat`, and `.exe` launching
- Claude Code SDK process launching
- Codex SDK process launching
- Antigravity and PTY launching
- Codex model-catalogue startup process
- CLI detection probes
- Process argument, environment, executable, and working-directory validation
- Clearer agent-launch error messages
- Workspace portability
- Correct AgentDock icon in the application, taskbar, installer, and portable executable
- Removed remaining Electron and Vite default icons
- Removed unwanted white and dark boxes around controls
- File explorer layout when preview is disabled
- Browser development-preview initialisation

### Technical validation

- Root cause of `SPAWN EINVAL` identified and fixed
- 59 Windows portability regression tests added
- 551 automated tests passing
- Six pre-existing macOS/POSIX-oriented tests still fail when run on Windows
- TypeScript checks pass
- Production build passes
- Native PTY check passes
- Windows installer packaging passes
- Windows portable packaging passes
- Packaged PTY assets verified
- No development-machine paths found in packaged output
- Correct AgentDock icons verified in final Windows artifacts
- Fixed build manually confirmed on a separate Windows testing PC

### Windows downloads

This release includes:

- Windows NSIS installer
- Windows portable executable
