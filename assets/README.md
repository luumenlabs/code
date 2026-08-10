# Assets

Shared art for Luu Code: the app icon, the mark, and anything the README or a
release page needs.

| File | Use |
|---|---|
| `icon.svg` | Master app icon. Everything else is rendered from this. |
| `icon.png` | 1024×1024 app icon. Linux, docs, store listings. |
| `icon.ico` | Windows app and taskbar icon (16–256). |
| `icon.icns` | macOS app icon (16–1024). |
| `png/icon-<size>.png` | Individual sizes, 16 through 1024. |
| `mark.svg` | The Luumen bulb on its own, no background. |
| `banner.png` | 1200×480 header image for the README and release notes. |

## Regenerating

Edit `icon.svg`, then:

```bash
pnpm assets:icons
```

That re-renders every PNG, rebuilds `icon.ico` and `icon.icns`, redraws the
banner, and refreshes the copy of the icon the app uses as its favicon. Commit
what changes — the build copies these files, it does not generate them.

## Colours

| | |
|---|---|
| Brand blue | `#3B82F6` |
| Surface | `#0A0A0B` → `#262A34` |
| Wordmark | Syne, 800 |
| Interface text | DM Sans |
