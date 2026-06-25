# server

Owner-gated guild-administration slash commands. Built by `buildServerModule(env)` (`index.ts`);
its commands are merged into the registry (`src/bot/command-registry.ts`) and gated by the
interaction router's owner check.

## Commands
- **`/create-category`** — create a category, optionally `private` (`permissions.ts` builds the
  member/role overwrites).
- **`/create-channel`** — create a `text`/`voice`/`forum`/`announcement` channel (`channel-type.ts`
  maps the choice to a discord.js `ChannelType`), with `topic`/`nsfw`/`slowmode`/`position`/`private`
  options.
- **`/create-role`** — create a role with `name`/`color`/`hoist`/`mentionable`/`position` options.

## Files
- `index.ts` — module factory (`buildServerModule`)
- `commands/{create-category,create-channel,create-role}.ts` — the three commands
- `channel-type.ts` — `mapChannelType(choice)` → `ChannelType`
- `permissions.ts` — `buildPrivateOverwrites(...)` for private categories/channels
