# Easy SteamGrid (Linux)

<a href="https://ko-fi.com/Y8Y019SFZ6"><img src="https://storage.ko-fi.com/cdn/kofi3.png?v=6" width="150" alt="ko-fi"></a>

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
| Wide Grid      | ✅ Working                  | ✅ Working |
| Icon           | ⚠️ Experimental (static only) | ⚠️ Experimental |

**Icon note:** Steam has no custom-artwork API for real games' icons, so the plugin uses the community-established librarycache route: it overwrites the cached icon file (backing up the original first — *Set original image* restores it). Both librarycache layouts are supported: the modern hash-named format and the older named-file format (`icon.jpg`). Steam content-sniffs the bytes, so SGDB's PNG icons apply as-is, transparency included. Caveats: a **Steam restart** is required for the library list to show the change, animation is not supported at this layer, Steam may silently revert the icon when the game's metadata updates (just re-apply), and **games that ship without any default icon cannot gain one** — Steam never consults the icon cache for those titles, so applying an icon to them has no visible effect.

---

## Known Behaviors & Open Questions

**Very large animated heroes can briefly blank during artwork refreshes.** Steam re-reads and re-decodes *all* of an app's custom artwork whenever any artwork type is applied for that app (and possibly on page revisits). Decode time scales with file weight, so a sufficiently heavy hero leaves a visible gap while Steam churns through it. Observed on the test machine (i7-4790K / RTX 3070): a **49.5 MB** animated hero blanked noticeably; a **31 MB** hero on the same game showed no visible gap. The threshold therefore sits somewhere in that range on this hardware, likely varies with CPU/decode speed, and probably scales with resolution and frame count rather than bytes alone.

By design, the plugin imposes **no size cap** — chunked IPC transfer handles any file size, and even a 49.5 MB hero applies and animates correctly; the blanking is purely a Steam-side redecode delay. Whether a soft warning (or opt-in cap) for heavyweight files is desirable is an open question. If you can help bracket the threshold on your hardware, please open an issue with your specs and the file size where blanking becomes visible.

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

**Settings note:** leave `disable_webp` **off** (the default) if you want animated artwork — enabling it removes WebP from SteamGridDB queries, and nearly all animated artwork on SGDB is WebP.

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
