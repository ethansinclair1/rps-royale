import { useEffect, useMemo, useRef, useState } from "react";
import { Client, Room } from "colyseus.js";

type Move = "rock" | "paper" | "scissors";

interface PlayerSnapshot {
  name: string;
  alive: boolean;
  connected: boolean;
}

interface DuelSnapshot {
  aId: string;
  aName: string;
  aMove: string;
  bId: string;
  bName: string;
  bMove: string;
  status: "choosing" | "resolved";
  winnerId: string;
  resultText: string;
  isBye: boolean;
  isDraw: boolean;
}

interface StateSnapshot {
  phase: "lobby" | "battle" | "gameover";
  round: number;
  winnerName: string;
  players: Record<string, PlayerSnapshot>;
  duels: DuelSnapshot[];
}

const DEFAULT_SERVER = import.meta.env.VITE_SERVER_URL || "ws://localhost:2567";
const MOVE_ICON: Record<Move, string> = { rock: "🪨", paper: "📄", scissors: "✂️" };
const MOVE_LABEL: Record<Move, string> = { rock: "ROCK", paper: "PAPER", scissors: "SCISSORS" };

function initials(name: string) {
  return name.trim().slice(0, 2).toUpperCase();
}

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
      <LandingScreen
        name={name}
        setName={setName}
        joinCode={joinCode}
        setJoinCode={setJoinCode}
        serverUrl={serverUrl}
        setServerUrl={setServerUrl}
        busy={busy}
        error={error}
        onCreate={createRoom}
        onJoin={joinRoom}
      />
    );
  }

  return (
    <ArenaScreen
      room={room}
      state={state}
      mySessionId={mySessionId.current}
      onStart={startGame}
      onThrow={throwMove}
      onRematch={rematch}
      onLeave={leaveRoom}
      error={error}
    />
  );
}

function LandingScreen(props: {
  name: string;
  setName: (v: string) => void;
  joinCode: string;
  setJoinCode: (v: string) => void;
  serverUrl: string;
  setServerUrl: (v: string) => void;
  busy: boolean;
  error: string;
  onCreate: () => void;
  onJoin: () => void;
}) {
  const { name, setName, joinCode, setJoinCode, serverUrl, setServerUrl, busy, error, onCreate, onJoin } = props;

  return (
    <div className="landing">
      <div className="landing-bg" aria-hidden="true">
        <span className="bg-icon bg-rock">🪨</span>
        <span className="bg-icon bg-paper">📄</span>
        <span className="bg-icon bg-scissors">✂️</span>
      </div>

      <div className="brand">
        <div className="brand-badge">
          <span>🪨</span>
          <span>📄</span>
          <span>✂️</span>
        </div>
        <h1 className="brand-title">
          RPS <span className="stroke">ROYALE</span>
        </h1>
        <p className="brand-tag">ONE-ON-ONE. SINGLE ELIMINATION. NO MERCY.</p>
      </div>

      <div className="panel">
        <label className="field">
          <span>FIGHTER NAME</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={16} placeholder="Player" />
        </label>

        <button className="btn btn-primary" onClick={onCreate} disabled={busy || !serverUrl}>
          CREATE ARENA
        </button>

        <div className="or-split">
          <span />
          OR
          <span />
        </div>

        <div className="join-row">
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            placeholder="ROOM CODE"
            maxLength={16}
          />
          <button className="btn" onClick={onJoin} disabled={busy || !joinCode.trim() || !serverUrl}>
            JOIN
          </button>
        </div>

        <details className="settings">
          <summary>Server settings</summary>
          <label className="field">
            <span>Server URL</span>
            <input
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="wss://your-server.example.com"
            />
          </label>
        </details>

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

function angleFor(index: number, total: number) {
  return (index / total) * 2 * Math.PI - Math.PI / 2;
}

function ArenaScreen(props: {
  room: Room;
  state: StateSnapshot;
  mySessionId: string;
  onStart: () => void;
  onThrow: (m: Move) => void;
  onRematch: () => void;
  onLeave: () => void;
  error: string;
}) {
  const { room, state, mySessionId, onStart, onThrow, onRematch, onLeave, error } = props;
  const players = useMemo(() => Object.entries(state.players), [state.players]);

  const activeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const d of state.duels) {
      ids.add(d.aId);
      if (d.bId) ids.add(d.bId);
    }
    return ids;
  }, [state.duels]);

  const ringSize = players.length <= 2 ? 190 : 220;
  const radius = ringSize / 2;

  return (
    <div className="arena">
      <div className="arena-header">
        <h1 className="brand-title small">
          RPS <span className="stroke">ROYALE</span>
        </h1>
        {state.phase !== "lobby" && state.phase !== "gameover" && (
          <div className="round-chip">
            {players.filter(([, p]) => p.alive).length <= 2 ? "FINAL" : `ROUND ${state.round}`}
          </div>
        )}
        <div className="room-code-chip">
          {room.id}
          <button className="copy-btn" onClick={() => navigator.clipboard.writeText(room.id)}>
            copy
          </button>
        </div>
      </div>

      <div className="ring-wrap" style={{ width: ringSize + 120, height: ringSize + 120 }}>
        <div className="ring" style={{ width: ringSize, height: ringSize }}>
          {state.phase === "gameover" && <div className="ring-center trophy">🏆</div>}
        </div>
        {players.map(([id, p], i) => {
          const angle = angleFor(i, players.length);
          const x = radius * Math.cos(angle);
          const y = radius * Math.sin(angle);
          const isMe = id === mySessionId;
          const isChampion = state.phase === "gameover" && state.winnerName === p.name;
          return (
            <div
              key={id}
              className={`avatar-pod ${p.alive ? "alive" : "dead"} ${isMe ? "me" : ""} ${
                activeIds.has(id) ? "active" : ""
              } ${isChampion ? "champion" : ""}`}
              style={{ transform: `translate(${x}px, ${y}px)` }}
            >
              <div className="avatar-circle">{initials(p.name)}</div>
              <div className="avatar-name">{p.name}</div>
              {!p.connected && <div className="avatar-flag">left</div>}
            </div>
          );
        })}
      </div>

      {state.phase === "lobby" && (
        <div className="lobby-controls">
          <p className="hint-line">{players.length}/4 fighters in the arena</p>
          <button className="btn btn-primary" onClick={onStart} disabled={players.length < 2}>
            START TOURNAMENT
          </button>
          {players.length < 2 && <p className="hint-line">Need at least 2 to begin.</p>}
        </div>
      )}

      {state.phase === "battle" && (
        <div className="duels">
          {state.duels.map((d) => (
            <DuelCard
              key={`${d.aId}|${d.bId}|${state.round}`}
              duel={d}
              mySessionId={mySessionId}
              onThrow={onThrow}
            />
          ))}
        </div>
      )}

      {state.phase === "gameover" && (
        <div className="gameover">
          <h2 className="champion-name">{state.winnerName} WINS THE ROYALE</h2>
          <button className="btn btn-primary" onClick={onRematch}>
            REMATCH
          </button>
        </div>
      )}

      <button className="link-btn" onClick={onLeave}>
        Leave arena
      </button>

      {error && <p className="error">{error}</p>}
    </div>
  );
}

function DuelCard(props: { duel: DuelSnapshot; mySessionId: string; onThrow: (m: Move) => void }) {
  const { duel, mySessionId, onThrow } = props;
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (duel.status === "resolved" && !duel.isBye) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 1400);
      return () => clearTimeout(t);
    }
  }, [duel.status, duel.resultText]);

  if (duel.isBye) {
    return (
      <div className="duel-card bye">
        <span className="bye-icon">🎟️</span>
        <strong>{duel.aName}</strong> skips this round
      </div>
    );
  }

  const iAmA = duel.aId === mySessionId;
  const iAmB = duel.bId === mySessionId;
  const myMove = iAmA ? duel.aMove : iAmB ? duel.bMove : "";
  const canPick = (iAmA || iAmB) && duel.status === "choosing" && !myMove && !duel.isDraw;

  const revealed = duel.status === "resolved" || duel.isDraw;
  const aWon = duel.status === "resolved" && duel.winnerId === duel.aId;
  const bWon = duel.status === "resolved" && duel.winnerId === duel.bId;

  return (
    <div className={`duel-card ${revealed ? "revealed" : ""} ${flash ? "flash" : ""} ${duel.isDraw ? "draw" : ""}`}>
      <div className="duel-row">
        <FighterSlot name={duel.aName} move={duel.aMove as Move} revealed={revealed} won={aWon} lost={bWon} side="a" />
        <div className="vs-badge">VS</div>
        <FighterSlot name={duel.bName} move={duel.bMove as Move} revealed={revealed} won={bWon} lost={aWon} side="b" />
      </div>

      {duel.isDraw && <p className="duel-status draw-text">DRAW — RE-THROWING…</p>}
      {duel.status === "resolved" && !duel.isDraw && (
        <p className="duel-status result-text">
          {duel.resultText} — <strong>{duel.winnerId === duel.aId ? duel.aName : duel.bName}</strong> wins
        </p>
      )}
      {duel.status === "choosing" && !duel.isDraw && !canPick && (
        <p className="duel-status waiting-text">Waiting for both fighters…</p>
      )}

      {canPick && (
        <div className="picker">
          {(["rock", "paper", "scissors"] as Move[]).map((m) => (
            <button key={m} className="pick-btn" onClick={() => onThrow(m)}>
              <span>{MOVE_ICON[m]}</span>
              {MOVE_LABEL[m]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FighterSlot(props: {
  name: string;
  move: Move | "";
  revealed: boolean;
  won: boolean;
  lost: boolean;
  side: "a" | "b";
}) {
  const { name, move, revealed, won, lost, side } = props;
  return (
    <div className={`fighter fighter-${side} ${won ? "won" : ""} ${lost ? "lost" : ""}`}>
      <div className={`fighter-icon ${revealed && move ? "revealed" : "hidden"}`}>
        {revealed && move ? MOVE_ICON[move] : "❔"}
      </div>
      <div className="fighter-name">{name}</div>
    </div>
  );
}
