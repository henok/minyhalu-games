# 🎮 Minyhalu Games

A growing collection of browser games to play with friends. One repo, one
deploy pipeline — every game lives in its own folder and ships as its own
service.

## What's here

| Folder | What it is |
|---|---|
| [portal/](portal/) | The landing page — `minyhalu.com` |
| [hide-and-seek/](hide-and-seek/) | 🙈 Hide & Seek 3D — multiplayer hide and seek in a summer world |
| `render.yaml` | The deploy blueprint: every service, one file |

## Deploying (once)

1. Push this repo to GitHub.
2. On [render.com](https://render.com): **New + → Blueprint → pick this repo → Apply**.
3. Every `git push` after that auto-deploys. Build filters make sure a push
   only redeploys the services whose files changed.

**Custom domains:** in the Render dashboard, give `minyhalu-portal` the domain
`minyhalu.com` (+ `www`), and each game its subdomain (e.g.
`hide-and-seek.minyhalu.com`). Render shows the exact DNS record to add for
each. Subdomains (not subpaths) keep every game's WebSockets connecting
directly — no proxying.

## Adding a new game

1. Make a folder: `my-new-game/` with a `package.json` and `npm start` that
   serves on `process.env.PORT`.
2. Copy the hide-and-seek service block in [render.yaml](render.yaml), change
   `name`, `rootDir` and `buildFilter` to the new folder.
3. Add a card to [portal/index.html](portal/index.html).
4. Push. Render picks up the new service from the blueprint.

## Local development

```bash
cd hide-and-seek
nvm use       # Node 24 (see .nvmrc)
npm install
npm start     # http://localhost:3000
```
