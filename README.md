# steam-easygrid (Linux Fork)

A Linux-compatible fork of [steam-easygrid](https://github.com/luthor112/steam-easygrid) by **luthor112** — a [Millennium](https://steambrew.app) plugin that adds quick and easy [SteamGridDB](https://www.steamgriddb.com) integration to Steam.

---

## About This Fork

The original plugin was built primarily for Windows. On Linux, animated WebP images from SteamGridDB could not be applied as hero backgrounds because Steam's embedded Chromium context blocks cross-origin `fetch()` requests to the CDN, and Millennium's IPC layer has size limits that prevent large base64 payloads from being passed between Lua and JavaScript.

This fork reworks the image pipeline for Linux:

- **Animated heroes (`.webp`):** downloaded in Lua via `curl`, converted to APNG in the background using Python + Pillow, served locally over a lightweight HTTP server (port 27331), and injected as a DOM overlay on the hero canvas — working around Steam's canvas WebGL limitations entirely.
- **Static heroes / logos (`.png` / `.jpg`):** downloaded and base64-encoded in Lua, applied directly via `SetCustomArtworkForApp`.
- **Logo positioning:** uses `SetCustomLogoPositionForApp` to initialise Steam's logo rendering component for text-only games (those without a native CDN logo image), discovered through reverse-engineering the "Adjust Logo Position" right-click menu.
- **CDN logo detection:** a HEAD request to Steam's Akamai CDN determines whether a game already has a native logo, skipping the position call for games that don't need it.

Tested on **CachyOS / KDE Plasma 6 (Wayland)**.

---

## Current Status

| Image Type   | Status                  |
|--------------|-------------------------|
| Hero (animated WebP) | ✅ Working       |
| Hero (static PNG/JPG) | ✅ Working      |
| Logo (animated WebP) | ✅ Working        |
| Logo (static PNG/JPG) | ✅ Working      |
| Grid / Capsule | ❌ Not working          |
| Wide Grid    | ⚠️ Completely untested  |
| Icon         | ❌ Not working          |

Grids and icons are blocked by the same IPC size issue — large PNG files produce base64 payloads that exceed Millennium's transfer limit. A proper fix requires either a background compression pipeline (explored but blocked by process-detachment limitations in Millennium's Lua environment) or a different approach entirely.

---

## Requirements

- [Millennium](https://steambrew.app) installed on Linux
- `python3` with [Pillow](https://pypi.org/project/Pillow/) (`pip install Pillow`)
- `curl` (available on virtually all Linux distributions)
- A [SteamGridDB API key](https://www.steamgriddb.com/api/v2)

---

## Installation

1. Clone or download this repository into your Millennium plugins directory:
   ```
   ~/.local/share/millennium/plugins/steam-easygrid/
   ```
2. Add your SteamGridDB API key to `config.json` (copy from `defaults.json` if it doesn't exist).
3. Restart Steam (or reload Millennium).

---

## Credits

- **[luthor112](https://github.com/luthor112)** — original plugin author ([steam-easygrid](https://github.com/luthor112/steam-easygrid))
- **[SteamClientHomebrew](https://github.com/SteamClientHomebrew)** — [Millennium](https://github.com/SteamClientHomebrew/Millennium) framework
- **[SteamGridDB](https://www.steamgriddb.com)** — artwork database and API

---

## License

This fork inherits the license of the original project. See [LICENSE](LICENSE) for details.
