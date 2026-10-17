# Night Highway

A 60-second night driving game: weave through late traffic, chain near misses for points, and see how far one minute takes you. Built with Next.js (App Router) and three.js r128.

## Controls

| Key | Action |
| --- | --- |
| W / ↑ | Gas |
| S / ↓ | Brake |
| A D / ← → | Steer |
| Shift / Space | Nitro |
| V | Camera |
| C | Paint |
| L | Light glow |
| M | Sound |
| H | Hide HUD |
| P / Esc | Pause |
| R | Restart |
| F | Fullscreen |

On touch devices, on-screen buttons appear automatically.

## Run locally

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

## Structure

- `app/NightHighway.tsx` holds the game's HUD, title and results markup (client component)
- `app/engine.js` holds the WebGL renderer, post-processing, world, physics, audio and input
- `app/globals.css` holds the styles
