# RPS Royale

Rock paper scissors, but a bracket. 2-4 players get thrown into random 1v1 duels each round,
loser's out, winners get re-paired, last one standing wins. Ties on a duel just redo that one
duel, doesn't touch anyone else's fight.

Host starts the game and rematches. Join with a 4-letter code. Survive a round and you get a
random ability (scout, mirror, rewind, coin flip, sabotage) you can pop off mid-duel - 3 slots,
hover one to see what it does.

Built with a Colyseus server (`server/`) doing all the actual game logic, and a React client
(`client/`) that's basically just a dumb renderer of whatever state the server sends down.

## Running it

```bash
cd server && npm install && npm run dev
```

server on `ws://localhost:2567`, then in another terminal:

```bash
cd client && npm install && npm run dev
```

opens on `localhost:5173`. Create a room, send the code to whoever you're playing with.

## Deploying

Client goes to GitHub Pages, auto-deploys on push (see `.github/workflows/deploy.yml`).

Server needs an actual Node host since Pages is static-only - there's a `render.yaml` in here so
Render's blueprint deploy just works (dashboard.render.com/blueprints → connect the repo → Apply).
Railway/Fly work too, same build/start commands by hand.

Once it's up, either set a `RPS_SERVER_URL` repo variable so the client build points at it by
default, or just paste the `wss://` url into the "Server settings" thing on the page itself - no
rebuild needed.

## Making it an actual Discord Activity

Right now this is just a normal website. Turning it into something launchable from Discord's
activity menu needs a few things only you can do since it's tied to your Discord account:

- register an app in the [Discord dev portal](https://discord.com/developers/applications),
  flip on Activities
- wire in `@discord/embedded-app-sdk` on the client side
- point the portal's URL mapping at wherever this ends up hosted
- test it privately, then submit for review if you want it public

Docs are at docs.discord.com/developers/activities/overview, walks through the whole thing.
