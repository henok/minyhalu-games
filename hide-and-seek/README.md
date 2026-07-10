# 🙈 Hide & Seek 3D

A multiplayer 3D hide-and-seek game that runs in the browser. Make your own
character (tall, short, big, skinny — with your real face on it!), pick a map,
and play with friends using a 4-letter room code.

## How to run it

```bash
npm install     # first time only
npm start
```

Then open **http://localhost:3000** in your browser.

## How to play with friends

**Friends in your house / on your WiFi (easiest):**
When the server starts, it prints something like
`Friends on your WiFi: http://192.168.1.23:3000` — friends on the same WiFi
just open that address, type the 4-letter room code, and they're in.

**Publish it on the internet (permanent):**
Push this repo to GitHub, then on [render.com](https://render.com):
*New + → Blueprint → pick the repo → Apply* (the included `render.yaml` does the
rest). You get a permanent `https://….onrender.com` link anyone can play on.

**Friends far away (quick, temporary):**
Use a free tunnel so friends anywhere can reach your game:

```bash
# install once:  brew install cloudflared
cloudflared tunnel --url http://localhost:3000
```

It prints a `https://something.trycloudflare.com` link — send that to your
friends. (Or deploy the folder to any Node host like Render or Railway with
`npm start` as the start command.)

## The rules

- **Hiders** 🙈 — run *faster* than seekers. Your tools:
  - **Paint yourself** any color (press `P` for the palette), or press `C` to
    instantly camouflage as whatever you're looking at
  - **Poses**: `1` stand, `2` crouch, `3` lie flat, `4` curl into a ball
    (sneaky poses make you slower, so choose wisely!)
- **Seekers** 🔍 — get a tag-gun with **limited darts**: you start with 10 and
  can grab more from the glowing ammo boxes around the map, up to a hard cap
  of **20 per game**. Cover your eyes while the hiders hide, then click to
  shoot whoever you find. Run dry with no boxes left and you're eliminated —
  if every seeker is out, the hiders win!
- Seekers win by finding everyone before the 4-minute timer ends.
- Some maps have **two-story houses**: walk in the front door, climb the
  stairs, and peek out the open upstairs windows — or hide up there disguised
  as a chair, a potted plant or a floor lamp.

## Controls

| Key | Action |
|---|---|
| `W` / `↑` | Run forward |
| `←` / `→` | Turn left / right |
| `↓` | Spin around and run toward the camera |
| `A` / `D` | Sidestep |
| Mouse | Move the camera (it eases back behind you as you run) |
| `Space` | Jump (you can climb crates!) |
| Left click | Shoot (seekers only) |
| `1 2 3 4` | Poses (hiders only) |
| `G` | Dance 🕺 |
| `M` | Music on/off 🎵 |
| `P` / `C` | Paint palette / camo-match (hiders only) |
| `Esc` | Free your mouse |

## Joining friends

You can join by typing a 4-letter code, pick a game from the **Live games**
list, or hit **⚡ Quick join** to automatically hop into the busiest game
going. Running rounds accept new hiders any time. You can change your name
from inside the room and pick any character in the editor.

## Robot players

Small group? The host can add up to 6 **robot hiders** and 3 **robot
seekers** from the lobby. Robots hide, flee, hunt, shoot, and grab ammo boxes
on their own (they can't see through walls, promise). They can win "best
seeker" of the round but never enter the persistent scoreboard.

## Maps

All maps share a warm, cel-shaded "summer afternoon" art style — gradient
skies, blobby trees, swaying grass, drifting clouds, butterflies, and rolling
hills on the horizon.

- **🏘️ Summer Village** — a sunny street with houses, palm trees, lamps and gardens
- **🌴 Jungle** — giant trees, ferns, mushrooms, and dark caves you can hide inside
- **🏡 Sunny Garden** — bushes, a hedge maze, sheds and huts you can walk inside
- **📦 Crate Yard** — climbable crate stacks, barrels, and shipping containers
- **🌾 Golden Meadow** — golden-hour light, tall grass to lie down in, logs, and a hut

Most maps have little rooms — huts, sheds, containers, caves — that you can
actually walk into and hide inside.

## Characters

Pick a character from the dropdown: the Classic boy & girl (with sliders for
size, skin tone and outfit color) or an animated 3D model — Robot, Fox,
Soldier, X Bot. To add your own: drop a rigged `.glb` file into
`public/models/` and add an entry to `MODELS` in
[public/js/models.js](public/js/models.js) (bundled models come from the
three.js examples and Khronos glTF samples).

## Camouflage (hiders — right-click!)

Right-click opens the camouflage palette:

- **🎨 Paint** — tint yourself any color, or **✨ Match** whatever you're looking at
- **🍃 Leaves** — cover yourself in foliage colored like your surroundings
- **🎭 Disguise** — become a bush, crate, rock or barrel! You move slowly and
  wobble when you walk, and seekers can still shoot the prop if they get
  suspicious. Getting found drops the disguise.

## Tweaking the game

Game rules live at the top of [server.js](server.js) (`RULES`): hide time,
seek time, and shots per seeker. Speeds and paint colors are at the top of
[public/js/main.js](public/js/main.js). Maps are in
[public/js/maps.js](public/js/maps.js) — add your own!
