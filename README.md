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

## Discord Activity

The client and server can also run as an actual Discord Activity, not just a normal website.

The wrinkle: Activities run sandboxed inside Discord's own domain, so the game can't just talk
to the Render URL directly like the web version does - everything has to be same-origin. So for
Discord specifically, the Node server also serves the built client itself (`npm run build:render`
in `client/`, a separate build with `base: /` instead of the GitHub Pages subpath, output to
`client/dist-discord`, which `server/src/index.ts` serves as static files alongside the websocket).
`render.yaml`'s build command already does both builds.

It also skips the whole "share a room code" thing - `client/src/discord.ts` uses the Activity's
`instanceId` (stable per voice channel) as the room's join code automatically, so everyone who
opens it from the same call lands in the same game. And it does a quick OAuth identify handshake
so it can pull your Discord display name instead of asking you to type one - the server's
`/api/token` route handles the token exchange (needs `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`
set on Render; the secret only ever lives there, never in the client bundle).

What you still have to do by hand in the [dev portal](https://discord.com/developers/applications)
(tied to your account, can't be scripted):

1. Create the app, add a placeholder OAuth2 redirect (`https://127.0.0.1` is fine), enable
   Activities under Activities → Settings.
2. Activities → URL Mappings: root prefix `/` → your Render hostname (e.g.
   `rps-royale-server.onrender.com`). Since the server now serves both the client and the
   websocket from one origin, this one mapping covers everything.
3. Set `DISCORD_CLIENT_SECRET` in Render's dashboard (Environment tab) - grab it from the
   portal's OAuth2 page. Don't put it in the repo.
4. Turn on Developer Mode in your own Discord client (User Settings → Advanced), then launch the
   Activity from a voice channel in a server you're in to test it live.
5. Once it works, submit through the portal for App Directory review if you want it discoverable
   outside your own server.

Full tutorial: docs.discord.com/developers/docs/activities/building-an-activity
