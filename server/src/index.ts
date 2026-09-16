import { createServer } from "http";
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

app.get("/", (_req, res) => {
  res.send("RPS Royale server is running.");
});

gameServer.listen(port);
console.log(`RPS Royale server listening on ws://localhost:${port}`);
