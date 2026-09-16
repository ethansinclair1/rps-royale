# RPS Royale

Rock-paper-scissors battle royale for 2–4 players. Everyone throws at once each round;
whoever throws the losing move is eliminated. Last player standing wins.

- **Client:** React + Vite (`client/`), talks to the server over WebSockets via `colyseus.js`.
- **Server:** Node.js + TypeScript + [Colyseus](https://colyseus.io) (`server/`), authoritative game state and round resolution (`server/src/rooms/RPSRoyaleRoom.ts`).

## Elimination rules

Each round, every alive player picks rock, paper, or scissors at the same time.

- If everyone throws the **same move** → draw, round replays.
- If **two different moves** are thrown → everyone who threw the losing move is eliminated (could be one player or several).
- If **all three moves** appear → draw, round replays (no single move is "worse" than another in a 3-way cycle).

Play continues until one player remains.

## Running locally

**Server:**

```bash
cd server
npm install
npm run dev
```

Starts a Colyseus server on `ws://localhost:2567`.

**Client** (in a second terminal):

```bash
cd client
npm install
npm run dev
```

Opens the game at `http://localhost:5173`. One player clicks **Create Room**, shares the room
code, and the others click **Join Room** and paste it in.

## Deploying

### Client → GitHub Pages

A GitHub Actions workflow (`.github/workflows/deploy.yml`) builds `client/` and publishes it to
GitHub Pages automatically on every push to `main`. Once enabled (Settings → Pages → Source:
GitHub Actions), the game is live at:

```
https://<your-github-username>.github.io/rps-royale/
```

### Server → anywhere that runs Node

GitHub Pages only serves static files, so the Colyseus server needs to run somewhere that hosts
a live Node process — for example [Render](https://render.com), [Railway](https://railway.app), or
[Fly.io](https://fly.io), all of which have free tiers. This repo includes a `render.yaml`
blueprint, so on Render it's a one-click deploy:

1. Go to <https://dashboard.render.com/blueprints> (sign up free if you don't have an account —
   no card needed for the free tier).
2. Click **New Blueprint Instance**, connect your GitHub account, and pick the `rps-royale` repo.
3. Render reads `render.yaml` automatically — build/start commands and root dir are already set.
   Click **Apply**.
4. Wait for the first deploy to finish (a couple minutes), then copy the URL it gives you, e.g.
   `https://rps-royale-server.onrender.com` — the live server address is the same URL with
   `wss://` instead of `https://`.

(No Render account? Railway and Fly.io work the same way manually: new Web Service → root
directory `server` → build command `npm install && npm run build` → start command `npm start`.)

Once the server is deployed, either:

- Set a repository variable `RPS_SERVER_URL` (Settings → Secrets and variables → Actions →
  Variables) to your `wss://...` URL and re-run the deploy workflow, so the Pages build points at
  it by default, **or**
- Open the deployed game, expand **Server settings**, and paste the `wss://...` URL directly —
  it's saved in the browser and doesn't require a rebuild.

## Turning this into a Discord Activity

This repo is a fully working standalone multiplayer web game. To make it launchable from
Discord's Activities menu (the rocket-ship icon in a voice channel), there are additional steps
that require your own Discord account and can't be done by pushing code alone:

1. Create an Application at the [Discord Developer Portal](https://discord.com/developers/applications)
   and enable **Activities** for it.
2. Add [`@discord/embedded-app-sdk`](https://www.npmjs.com/package/@discord/embedded-app-sdk) to
   `client/` and initialize it so the app knows it's running inside Discord's iframe.
3. Configure **URL Mappings** in the Developer Portal to point at your deployed client and server
   (Discord proxies requests through a `discordsays.com` subdomain).
4. Test the Activity privately in your own server, then submit it through the Developer Portal for
   App Directory review to make it publicly discoverable.

Full walkthrough: <https://docs.discord.com/developers/activities/overview>
