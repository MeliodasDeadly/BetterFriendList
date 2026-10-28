<!--
  Author: Melio
  Plugin: BetterFriendList
  Description: Plugin documentation and usage overview
-->

# BetterFriendList

Vencord plugin that improves the **Friends** tab: activity search and filters, plus a dedicated **Playing** page for games in progress.

![BetterFriendList preview](https://i.ibb.co/dJfJfYkg/Capture-d-cran-2026-10-28-010726.png)

## Features

### Search & filters
- Search bar (username, nickname, game, Rich Presence text)
- **Filters** button: categories (Games, Stream, Listening, Watching, etc.) and per-game chips
- **All** category by default; an applied filter shows as a token in the field
- UI language follows the Discord client (**EN** / **FR**)

### Playing tab
- Cards per game: RPC cover, name, friend count, player list
- **Join** button (disabled when unavailable)
- Click avatar / name → Discord profile
- **In Voice Chat** icon next to the name (join the channel)
- Your current game highlighted first (subtle outline)
- Card size: Compact / Normal / Large (preference saved)
- **Live** updates plus a countdown to the next periodic refresh

### Settings
| Option | Description |
|--------|-------------|
| **Game card size** | Card size on the Playing page |
| **Refresh interval** | Friends UI refresh every 30–60s (only while on Friends) |

## Installation (userplugin)

1. Build Vencord [from source](https://docs.vencord.dev/installing/)
2. Copy the `betterFriendList` folder into `src/userplugins/`
3. Rebuild (`pnpm build` / `pnpm watch`) and restart Discord
4. Enable **BetterFriendList** in Vencord plugins

Guide: [Installing custom plugins](https://docs.vencord.dev/installing/custom-plugins/)

## Structure

```
betterFriendList/
├── index.tsx           # Plugin entry
├── README.md
├── components/         # Search + Playing UI
├── styles/             # CSS
├── i18n/               # EN / FR
├── settings/           # Persisted options
└── utils/              # Periodic refresh
```

## Author

**Melio** (`Meliodouil`)
