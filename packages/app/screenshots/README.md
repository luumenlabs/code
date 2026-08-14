# Screenshots

Throwaway scaffolding for README and showcase images.

## Use

From `packages/app`:

```sh
node screenshots/shoot.mjs              # → screenshots/out/luu-code.png
node screenshots/shoot.mjs --open       # opens the window; you take the shot
node screenshots/shoot.mjs --no-build   # reuse whatever is already in dist/
```

Regenerating the README's header image:

```sh
node screenshots/shoot.mjs --out=../../assets/screenshot.webp
```

Other flags: `--width=`, `--height=`, `--scale=`, `--quality=`, `--settle=` (ms
before the shutter — raise it if a font or spinner is not ready), and `--tab=`
(`studio`, `changes`, or `output` — which dock tab is open; `changes` by
default).

Which tab is open is React state rather than anything the fake bridge can
declare, so `--tab=` clicks the switcher. A tab that is not there is an error,
not a shot of the wrong panel.

**The extension picks the format.** `.webp` is encoded by the Chromium already
running, so there is no `sharp` and no native dependency in a folder whose whole
point is being disposable; anything else is written as PNG. WebP lands around
half the size at `--quality=0.92`, with 11px UI text still crisp.

`--open` leaves the window up so you can click into Settings, open the model
picker, or scroll the transcript before capturing it yourself.

`--scale` raises pixel density but *lowers* the room available in layout pixels,
because a real window cannot be bigger than its display — on 1080p, `--scale=2`
clamps 1440x900 into something cramped rather than producing 2880x1800. It warns
when that happens. `--scale=2 --width=940 --height=500` fits, and gives 1880x1000.

## What is in the picture

- **Six places**, all sequels of games that exist. Four hold finished work.
- **Three chats mid-turn** — two in Bee Simulator 6, one in Tower of Hell
  Remastered — so the sidebar spinners and the per-chat provider marks are both
  in shot.
- **Two archived chats**, so the Archived fold is not empty.
- **The open chat** has two turns: one landed, folded to "Worked for 42s" with
  the answer under it, and one still running with its thinking, Roblox
  operations, and tool calls open, plus the live clock. Real tool names, real
  Luau, no screenshots.
- **The dock on Changes**, holding three diffs the place has taken: two from the
  honey-balancing chat and one from the open one, because the journal is per
  Studio window rather than per conversation. They start open, so the panel is a
  stack of real diffs rather than a list of rows.
- **One of them under the live turn** as well, as the "1 change" fold — the same
  record, read from the conversation's own copy.
- **Codex one version behind**, so the amber count on the Settings button and
  the Providers tab is visible rather than something you have to describe.

Timestamps are relative to when you run it, so "8h ago" is always "8h ago" and
the live turn always reads about "1m 12s".

To change any of it, edit `mock.cjs` — it is plain CommonJS with no build step,
and `--no-build` makes the loop fast.
