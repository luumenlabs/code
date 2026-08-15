# @luumen/code-site

Luu Code's landing page. One page, marketing only — no docs live here.

```
pnpm site          # dev server on http://localhost:5274
pnpm site:build    # static output in packages/site/dist
```

`dist/` is a plain static bundle; serve it from anywhere.

## Layout

`src/sections/` is the page, top to bottom, in the order `App.tsx` composes it.
`src/components/` holds the reveal-on-scroll wrapper and the three marks the app
does not have.

## Borrowed from the app

The showcases are the app's own components, imported through the `@app` alias:
`Switch`, `Badge`, `Brand`, `ProviderIcon`. Their permission labels, activity
glyphs and example prompts are the strings the app ships.

App files import through `@`, which resolves to `src/` here — anything borrowed
needs its `@/…` imports to exist on this side too. Only `@/lib/utils` does.

`src/styles.css` carries the app's dark token block verbatim and points
`@source` at the app's renderer so those class names get generated. Change a
token in the app and change it here.

## The hero shot

`assets/screenshot.webp` at the repo root, through the `@assets` alias. The
README uses the same file. Its intrinsic size is set on the `img` in
`sections/Hero.tsx`; a replacement with different dimensions needs that updated
or the page shifts as it loads.
