import { createServer } from "http";
import path from "path";
import express from "express";
import cors from "cors";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { RPSRoyaleRoom } from "./rooms/RPSRoyaleRoom";

const app = express();
app.use(cors());
app.use(express.json());

const port = Number(process.env.PORT) || 2567;
const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("rps_royale", RPSRoyaleRoom);

// Exchanges a Discord OAuth2 authorization code for an access token. The
// client secret only ever lives here (server env var), never in the bundle
// the browser downloads.
app.post("/api/token", async (req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(500).json({ error: "Discord OAuth is not configured on this server." });
    return;
  }

  try {
    const response = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code: req.body?.code ?? "",
      }),
    });
    const data = (await response.json()) as { access_token?: string };
    res.json({ access_token: data.access_token });
  } catch {
    res.status(502).json({ error: "Failed to reach Discord's token endpoint." });
  }
});

// Serves the client build produced for Discord (see client/package.json's
// "build:render" script, which uses base "/" instead of the GitHub Pages
// subpath) so the Activity and its WebSocket share one origin.
const clientDist = path.join(__dirname, "../../client/dist-discord");
app.use(express.static(clientDist));
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"), (err) => {
    if (err) res.status(200).send("RPS Royale server is running.");
  });
});

gameServer.listen(port);
console.log(`RPS Royale server listening on ws://localhost:${port}`);
