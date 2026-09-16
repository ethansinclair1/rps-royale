import { useEffect, useRef, useState } from "react";
import { Client, Room } from "colyseus.js";

type Move = "rock" | "paper" | "scissors";

interface PlayerSnapshot {
  name: string;
  alive: boolean;
  move: string;
  connected: boolean;
}

interface StateSnapshot {
  phase: "lobby" | "choosing" | "gameover";
  round: number;
  log: string[];
  winnerName: string;
  players: Record<string, PlayerSnapshot>;
}

const DEFAULT_SERVER = import.meta.env.VITE_SERVER_URL || "ws://localhost:2567";
const MOVE_ICONS: Record<Move, string> = { rock: "🪨", paper: "📄", scissors: "✂️" };

export default function App() {
  const [serverUrl, setServerUrl] = useState(
    () => localStorage.getItem("rps-royale-server") || DEFAULT_SERVER
  );
  const [name, setName] = useState(() => localStorage.getItem("rps-royale-name") || "");
  const [joinCode, setJoinCode] = useState("");
  const [room, setRoom] = useState<Room | null>(null);
  const [state, setState] = useState<StateSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mySessionId = useRef("");
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state?.log.length]);

  function attachRoom(r: Room) {
    mySessionId.current = r.sessionId;
    setRoom(r);
    setError("");
    r.onStateChange((s: unknown) => setState((s as { toJSON(): StateSnapshot }).toJSON()));
    r.onLeave(() => {
      setRoom(null);
      setState(null);
    });
    r.onError((_code, message) => setError(message || "Connection error"));
  }

  async function createRoom() {
    setBusy(true);
    setError("");
    try {
      const client = new Client(serverUrl);
      const r = await client.create("rps_royale", { name: name || "Player" });
      localStorage.setItem("rps-royale-server", serverUrl);
      localStorage.setItem("rps-royale-name", name);
      attachRoom(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create room. Is the server running?");
    } finally {
      setBusy(false);
    }
  }

  async function joinRoom() {
    if (!joinCode.trim()) return;
    setBusy(true);
    setError("");
    try {
      const client = new Client(serverUrl);
      const r = await client.joinById(joinCode.trim(), { name: name || "Player" });
      localStorage.setItem("rps-royale-server", serverUrl);
      localStorage.setItem("rps-royale-name", name);
      attachRoom(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to join room. Check the code and server URL.");
    } finally {
      setBusy(false);
    }
  }

  function startGame() {
    room?.send("start");
  }

  function throwMove(move: Move) {
    room?.send("move", { move });
  }

  function rematch() {
    room?.send("rematch");
  }

  function leaveRoom() {
    room?.leave();
    setRoom(null);
    setState(null);
  }

  if (!room || !state) {
    return (
      <div className="screen center">
        <h1>
          RPS <span className="accent">Royale</span>
        </h1>
        <p className="tagline">🪨 📄 ✂️ Last hand standing wins. 2–4 players.</p>

        <label className="field">
          <span>Your name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={16}
            placeholder="Player"
          />
        </label>

        <div className="row">
          <button className="primary" onClick={createRoom} disabled={busy || !serverUrl}>
            Create Room
          </button>
        </div>

        <div className="divider">or</div>

        <div className="row join-row">
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            placeholder="Room code"
            maxLength={16}
          />
          <button onClick={joinRoom} disabled={busy || !joinCode.trim() || !serverUrl}>
            Join Room
          </button>
        </div>

        <details className="settings">
          <summary>Server settings</summary>
          <label className="field">
            <span>Server URL</span>
            <input
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="ws://localhost:2567"
            />
          </label>
          <p className="hint">Point this at your deployed Colyseus server (wss://your-server.example.com).</p>
        </details>

        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  const players = Object.entries(state.players);
  const me = state.players[mySessionId.current];

  return (
    <div className="screen">
      <h1>
        RPS <span className="accent">Royale</span>
      </h1>
      <p className="room-code">
        Room code: <strong>{room.id}</strong>{" "}
        <button className="link" onClick={() => navigator.clipboard.writeText(room.id)}>
          copy
        </button>
      </p>

      <div className="players">
        {players.map(([id, p]) => (
          <div
            key={id}
            className={`player-chip ${p.alive ? "alive" : "eliminated"} ${
              id === mySessionId.current ? "me" : ""
            }`}
          >
            {p.name}
            {!p.connected && " (disconnected)"}
            {!p.alive && " 💀"}
            {state.phase === "choosing" && p.alive && p.move && " ✅"}
          </div>
        ))}
      </div>

      {state.phase === "lobby" && (
        <div className="center">
          <p>Waiting for players... ({players.length}/4)</p>
          <button className="primary" onClick={startGame} disabled={players.length < 2}>
            Start Game
          </button>
          {players.length < 2 && <p className="hint">Need at least 2 players to start.</p>}
        </div>
      )}

      {state.phase === "choosing" && (
        <div className="center">
          <p className="round-label">Round {state.round}</p>
          {me?.alive ? (
            me.move ? (
              <p className="waiting">
                You threw {MOVE_ICONS[me.move as Move]} {me.move}. Waiting for other players...
              </p>
            ) : (
              <div className="moves">
                {(["rock", "paper", "scissors"] as Move[]).map((m) => (
                  <button key={m} className="move-btn" onClick={() => throwMove(m)}>
                    <span className="move-icon">{MOVE_ICONS[m]}</span>
                    {m}
                  </button>
                ))}
              </div>
            )
          ) : (
            <p className="waiting">You've been eliminated. Watching the rest of the round.</p>
          )}
        </div>
      )}

      {state.phase === "gameover" && (
        <div className="center">
          <h2 className="winner">🏆 {state.winnerName} wins!</h2>
          <button className="primary" onClick={rematch}>
            Rematch
          </button>
        </div>
      )}

      <div className="log">
        {state.log.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
        <div ref={logEndRef} />
      </div>

      <button className="link leave" onClick={leaveRoom}>
        Leave room
      </button>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
