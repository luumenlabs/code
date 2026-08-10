# Assets

Shared art for Luu Code: the app icon, the mark, and anything the README or a
release page needs.

Two channels: blue for releases, purple for nightly builds, so the two are told
apart at a glance in a dock or a taskbar.

| File | Use |
|---|---|
| `icon.svg` | Master release icon. Everything blue is rendered from this. |
| `icon-nightly.svg` | Master nightly icon. |
| `icon.png`, `icon-nightly.png` | 1024×1024. Linux, docs, store listings. |
| `icon.ico`, `icon-nightly.ico` | Windows app and taskbar icons (16–256). |
| `icon.icns`, `icon-nightly.icns` | macOS app icons (16–1024). |
| `png/icon-<size>.png` | Individual sizes, 16 through 1024. |
| `png/icon-nightly-<size>.png` | The same, for nightly. |
| `mark.svg` | The Luumen bulb on its own, no background. |
| `banner.png` | 1200×480 header image for the README and release notes. |

The app picks its channel at runtime: `LUU_CODE_CHANNEL=nightly`, or a version
string containing `nightly`.

## Regenerating

Edit a master SVG, then:

```bash
pnpm assets:icons
```

That re-renders every PNG for both channels, rebuilds the `.ico` and `.icns`
files, redraws the banner, and refreshes the copy of the icon the app uses as
its favicon. Commit what changes — the build copies these files, it does not
generate them.

## Colours

| | |
|---|---|
| Brand blue | `#3B82F6` |
| Release surface | `#0A0A0B` → `#262A34` |
| Nightly purple | `#A855F7` |
| Nightly surface | `#1B0640` → `#6D28D9` |
| Wordmark | Syne, 800 |
| Interface text | DM Sans |
