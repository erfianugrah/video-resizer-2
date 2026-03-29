# video-resizer dashboard

Admin dashboard for the video-resizer Cloudflare Worker. Astro 6 + React 19 + Radix UI + Tailwind CSS v4.

## Stack

| Layer | Technology |
|-------|-----------|
| Framework | Astro 6 (static output) + React 19 |
| Styling | Tailwind CSS v4, Lovelace dark palette |
| UI Primitives | Radix UI (Tabs, Tooltip, Slot) + CVA variants |
| Icons | lucide-react |
| Class Merging | clsx + tailwind-merge (`cn()`) |

## Structure

```
src/
  layouts/Layout.astro        # HTML shell, global CSS import
  pages/index.astro           # Single page, mounts <Dashboard client:load />
  styles/global.css            # Lovelace palette, shadcn CSS vars, animations
  lib/
    utils.ts                   # cn(), copyToClipboard, BASE, status colors, formatters
    typography.ts              # T object — shared text style tokens
  components/
    Dashboard.tsx              # Root: header, token input, Radix Tabs
    AnalyticsTab.tsx            # Stats, breakdowns, error table, skeletons
    JobsTab.tsx                 # SSE progress, polling, filtering, expandable rows
    DebugTab.tsx                # URL debugger, diagnostics, response headers
    ui/                         # Reusable primitives
      button.tsx, card.tsx, badge.tsx, table.tsx,
      tabs.tsx, input.tsx, skeleton.tsx, tooltip.tsx
```

## Commands

| Command | Action |
|---------|--------|
| `npm run dev` | Local dev server at localhost:4321 |
| `npm run build` | Build to `./dist/` for Worker ASSETS binding |
