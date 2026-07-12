# Easy SteamGrid (Linux)

A [Millennium](https://steambrew.app) plugin that adds quick and easy [SteamGridDB](https://www.steamgriddb.com) integration to Steam on Linux — grids, heroes, and logos, **including animated artwork**, applied instantly with zero conversion.

Originally forked from [steam-easygrid](https://github.com/luthor112/steam-easygrid) by **luthor112**; v5 is a ground-up rewrite of the artwork pipeline.

Tested on **CachyOS / KDE Plasma 6 (Wayland)**.

---

## Current Status

| Image Type     | Animated                    | Static |
|----------------|-----------------------------|--------|
| Grid / Capsule | ✅ Working                  | ✅ Working |
| Hero           | ✅ Working (any size)       | ✅ Working |
| Logo           | ✅ Working                  | ✅ Working |
| Wide Grid      | ⚠️ Untested                 | ⚠️ Untested |
| Icon           | ❌ Not working              | ❌ Not working |

**Icon note:** the plugin delivers icon bytes to Steam correctly, but Steam's `SetCustomArtworkForApp` API does not appear to service the icon asset type — icons for real (non-shortcut) Steam games live in a different mechanism. Under investigation.

---

## How v5 Works (and why there's no more conversion)

Earlier versions downloaded animated WebP files, re-encoded them to APNG with Python/Pillow, served them from a local HTTP server, and injected DOM overlays to force animation. All of that is gone, replaced by two observations:

1. **Steam natively renders animated WebP** — as long as the file's *name* says `.png`, Steam content-sniffs the actual bytes and animates them. This is the same trick behind manually applying artwork via right-click → *Set Custom Artwork*.
2. **SteamGridDB already hosts every WebP asset under a `.png` URL** — the site's "Download as .PNG" button serves the identical bytes from a `…-fakepng.png` address. No local conversion can beat a file that's already correct.

So the entire pipeline is now:

- **Fetch** — WebP assets are fetched from their `-fakepng.png` URL (with a transparent fallback to the original URL, which serves byte-identical content). Assets that are already PNG/JPG are fetched as-is.
- **Cache** — files land in `cache/` inside the plugin folder, keyed by a hash of the fetched URL. Purge buttons are in the plugin settings.
- **Apply** — the complete, untouched file bytes are handed to Steam's own `SetCustomArtworkForApp`, exactly like the manual dialog. Files over the 6MB IPC-safe ceiling are streamed from the backend in 4M-character chunks and reassembled before applying, so any size applies instantly — no restarts, ever.

Logos additionally use `SetCustomLogoPositionForApp` to initialise Steam's logo component for text-only games (those without a native CDN logo).

**What was deleted in v5:** the Python/Pillow dependency, the WebP→APNG converter, the localhost HTTP server (port 27331), all DOM overlay/scanning machinery, and the CONVERTING/polling state machine. The plugin is roughly 40% less code than v4.

---

## Requirements

- [Millennium](https://steambrew.app) installed on Linux
- `curl` and coreutils (`base64`, `md5sum`) — present on virtually every distribution
- **No Python required** (new in v5)
- A free [SteamGridDB API key](https://www.steamgriddb.com/profile/preferences/api)

---

## Installation

1. Clone this repository into your Millennium plugins directory:
   ```
   ~/.local/share/millennium/plugins/steam-easygrid/
   ```
2. Build the frontend:
   ```
   corepack enable && pnpm install && pnpm run build
   ```
3. Enter your SteamGridDB API key in the plugin's settings panel. It is stored locally in `config.json`, which is gitignored — **never commit that file**.
4. Enable the plugin in Millennium and restart Steam.

---

## Usage

- **Double-click a game's hero banner**, or use the **SG** button on the game page, to open the artwork picker.
- Toolbar buttons on **Home** and **Collection** views open the picker for the selected context.
- **Auto replace images** fetches and applies the first matching artwork for every image type in one click.
- Filters (NSFW / humor / epilepsy, styles, dimensions, animated-first) are configurable per image type in settings.

**Settings note:** leave `disable_webp` **off** if you want animated artwork — enabling it removes WebP from SteamGridDB queries, and nearly all animated artwork on SGDB is WebP.

---

## Windows?

This is a Linux-first fork. A minimal Windows code path exists (single-return transfers only, ≤6MB, no chunked streaming) but is untested. The upstream project is the better starting point for Windows.

---

## Credits

- **[luthor112](https://github.com/luthor112)** — original plugin author ([steam-easygrid](https://github.com/luthor112/steam-easygrid))
- **[SteamClientHomebrew](https://github.com/SteamClientHomebrew)** — the [Millennium](https://github.com/SteamClientHomebrew/Millennium) framework
- **[SteamGridDB](https://www.steamgriddb.com)** — artwork database, API, and the `-fakepng.png` endpoint that makes v5 possible

## License

MIT — inherited from the original project. See [LICENSE](LICENSE).
