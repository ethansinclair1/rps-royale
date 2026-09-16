import { useEffect, useMemo, useRef, useState } from "react";
import { Client, Room } from "colyseus.js";
import * as sfx from "./sfx";
import { isInDiscord, discordServerUrl, setupDiscord, type DiscordSession } from "./discord";

type Move = "rock" | "paper" | "scissors";

interface PlayerSnapshot {
  name: string;
  alive: boolean;
  connected: boolean;
  eliminatedRound: number;
  wins: number;
  abilities: string[];
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
  winMove: string;
  loseMove: string;
  resultText: string;
  isBye: boolean;
  isDraw: boolean;
  abilityEvent: string;
}

type AbilityId = "scout" | "mirror" | "rewind" | "coinflip" | "sabotage";

const ABILITY_INFO: Record<AbilityId, { name: string; icon: string; description: string }> = {
  scout: {
    name: "Scout",
    icon: "🔍",
    description: "Narrows your opponent's move down to 2 of 3 possibilities.",
  },
  mirror: {
    name: "Mirror",
    icon: "🪞",
    description: "Copy your opponent's move once they've thrown, forcing a draw + re-throw.",
  },
  rewind: {
    name: "Rewind",
    icon: "⏪",
    description: "Undo a loss you just suffered and force a re-throw. Only works right after losing.",
  },
  coinflip: {
    name: "Coin Flip",
    icon: "🎲",
    description: "50/50 chance to win or lose this duel instantly. Real risk, either way.",
  },
  sabotage: {
    name: "Sabotage",
    icon: "🔧",
    description: "Steal a random ability from your opponent's inventory.",
  },
};

interface StateSnapshot {
  phase: "lobby" | "battle" | "gameover";
  round: number;
  winnerName: string;
  hostId: string;
  joinCode: string;
  players: Record<string, PlayerSnapshot>;
  duels: DuelSnapshot[];
}

const DEFAULT_SERVER = discordServerUrl() || import.meta.env.VITE_SERVER_URL || "ws://localhost:2567";
const MOVE_ICON: Record<Move, string> = { rock: "🪨", paper: "📄", scissors: "✂️" };
const MOVE_LABEL: Record<Move, string> = { rock: "ROCK", paper: "PAPER", scissors: "SCISSORS" };
const IMPACT_ICON: Record<Move, string> = { rock: "💥", paper: "✨", scissors: "✂️" };
const CONSENTED_CLOSE_CODE = 4000;
const SESSION_KEY = "rps-royale-session";
const REJOIN_ATTEMPTS = 5;
const REJOIN_RETRY_MS = 2500;

function initials(name: string) {
  return name.trim().slice(0, 2).toUpperCase();
}

interface StoredSession {
  serverUrl: string;
  joinCode: string;
  token: string;
  name: string;
}

function readStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.token || !parsed?.serverUrl) return null;
    return parsed as StoredSession;
  } catch {
    return null;
  }
}

function saveSession(session: StoredSession) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearStoredSession() {
  localStorage.removeItem(SESSION_KEY);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const [reconnectStatus, setReconnectStatus] = useState("");
  const [resumable, setResumable] = useState<StoredSession | null>(() => readStoredSession());
  const [scoutResult, setScoutResult] = useState<{ candidates: Move[]; opponentName: string } | null>(null);
  const mySessionId = useRef("");
  const nameRef = useRef(name);

  useEffect(() => {
    if (!scoutResult) return;
    const t = setTimeout(() => setScoutResult(null), 4000);
    return () => clearTimeout(t);
  }, [scoutResult]);

  useEffect(() => {
    nameRef.current = name;
  }, [name]);

  useEffect(() => {
    if (!isInDiscord()) return;
    let cancelled = false;

    setReconnectStatus("Entering the arena…");
    setupDiscord().then((session) => {
      if (cancelled || !session) return;
      autoJoinDiscordRoom(session);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function autoJoinDiscordRoom(session: DiscordSession) {
    const url = discordServerUrl() || serverUrl;
    const displayName = session.username || nameRef.current || "Player";
    try {
      const client = new Client(url);
      const available = await client.getAvailableRooms("rps_royale");
      const match = available.find(
        (r) => (r.metadata as { code?: string } | undefined)?.code === session.instanceId
      );
      const r = match
        ? await client.joinById(match.roomId, { name: displayName })
        : await client.create("rps_royale", { name: displayName, forcedCode: session.instanceId });
      setName(displayName);
      localStorage.setItem("rps-royale-server", url);
      localStorage.setItem("rps-royale-name", displayName);
      attachRoom(r, url);
    } catch (e) {
      // Fall back to the normal manual create/join screen rather than getting stuck.
      setReconnectStatus("");
      setName(displayName);
      setError(e instanceof Error ? e.message : "Couldn't auto-join this channel's game - try manually below.");
    }
  }

  function attachRoom(r: Room, serverUrlUsed: string) {
    mySessionId.current = r.sessionId;
    setRoom(r);
    setReconnectStatus("");
    setError("");

    r.onStateChange((s: unknown) => setState((s as { toJSON(): StateSnapshot }).toJSON()));

    r.onMessage("rejoin-token", (msg: { token: string }) => {
      const session: StoredSession = {
        serverUrl: serverUrlUsed,
        joinCode: r.state?.joinCode || "",
        token: msg.token,
        name: nameRef.current || "Player",
      };
      saveSession(session);
      setResumable(session);
    });

    r.onMessage("scout-result", (msg: { candidates: Move[]; opponentName: string }) => {
      setScoutResult(msg);
    });

    r.onLeave((code: number) => {
      if (code === CONSENTED_CLOSE_CODE) {
        setRoom(null);
        setState(null);
        return;
      }
      // Unexpected drop (network blip, backgrounded tab, server hiccup) -
      // try to rejoin the same seat instead of just kicking them to the menu.
      const roomId = r.id;
      const joinCodeAtDrop = r.state?.joinCode || "";
      setRoom(null);
      setState(null);
      rejoinAfterDrop(roomId, joinCodeAtDrop);
    });

    r.onError((_code, message) => setError(message || "Connection error"));
  }

  async function rejoinAfterDrop(roomId: string, joinCodeAtDrop: string) {
    const stored = readStoredSession();
    if (!stored) {
      setError("Lost connection to the arena.");
      return;
    }

    for (let attempt = 1; attempt <= REJOIN_ATTEMPTS; attempt++) {
      setReconnectStatus(`Reconnecting… (${attempt}/${REJOIN_ATTEMPTS})`);
      try {
        const client = new Client(stored.serverUrl);
        const r = await client.joinById(roomId, { name: stored.name, rejoinToken: stored.token });
        attachRoom(r, stored.serverUrl);
        return;
      } catch {
        if (attempt < REJOIN_ATTEMPTS) await sleep(REJOIN_RETRY_MS);
      }
    }

    // The room itself may have restarted (e.g. a cold-started free-tier
    // server) - try resolving a fresh roomId from the join code before giving up.
    const code = joinCodeAtDrop || stored.joinCode;
    if (code) {
      try {
        setReconnectStatus("Looking for the arena…");
        const client = new Client(stored.serverUrl);
        const available = await client.getAvailableRooms("rps_royale");
        const match = available.find((rm) => (rm.metadata as { code?: string } | undefined)?.code === code);
        if (match) {
          const r = await client.joinById(match.roomId, { name: stored.name, rejoinToken: stored.token });
          attachRoom(r, stored.serverUrl);
          return;
        }
      } catch {
        // fall through to failure below
      }
    }

    setReconnectStatus("");
    setError("Lost connection to the arena. It may have ended - try rejoining with the code below.");
  }

  async function createRoom() {
    sfx.playClick();
    setBusy(true);
    setError("");
    try {
      const client = new Client(serverUrl);
      const r = await client.create("rps_royale", { name: name || "Player" });
      localStorage.setItem("rps-royale-server", serverUrl);
      localStorage.setItem("rps-royale-name", name);
      attachRoom(r, serverUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create room. Is the server running?");
    } finally {
      setBusy(false);
    }
  }

  async function joinRoom() {
    const code = joinCode.trim().toUpperCase();
    if (!code) return;
    sfx.playClick();
    setBusy(true);
    setError("");
    try {
      const client = new Client(serverUrl);
      const available = await client.getAvailableRooms("rps_royale");
      const match = available.find((r) => (r.metadata as { code?: string } | undefined)?.code === code);
      if (!match) {
        setError("Room not found. Check the code.");
        return;
      }
      const r = await client.joinById(match.roomId, { name: name || "Player" });
      localStorage.setItem("rps-royale-server", serverUrl);
      localStorage.setItem("rps-royale-name", name);
      attachRoom(r, serverUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to join room. Check the code and server URL.");
    } finally {
      setBusy(false);
    }
  }

  async function rejoinPrevious() {
    if (!resumable) return;
    sfx.playClick();
    setBusy(true);
    setError("");
    try {
      const client = new Client(resumable.serverUrl);
      const available = await client.getAvailableRooms("rps_royale");
      const match = available.find((r) => (r.metadata as { code?: string } | undefined)?.code === resumable.joinCode);
      if (!match) {
        setError("That arena is gone. Ask the host for a new code.");
        clearStoredSession();
        setResumable(null);
        return;
      }
      const r = await client.joinById(match.roomId, { name: resumable.name, rejoinToken: resumable.token });
      setServerUrl(resumable.serverUrl);
      setName(resumable.name);
      attachRoom(r, resumable.serverUrl);
    } catch {
      setError("Could not rejoin - the session may have expired.");
      clearStoredSession();
      setResumable(null);
    } finally {
      setBusy(false);
    }
  }

  function startGame() {
    sfx.playClick();
    room?.send("start");
  }

  function throwMove(move: Move) {
    sfx.playPick();
    room?.send("move", { move });
  }

  function activateAbility(abilityId: AbilityId) {
    sfx.playClick();
    room?.send("ability", { abilityId });
  }

  function rematch() {
    sfx.playClick();
    room?.send("rematch");
  }

  function leaveRoom() {
    sfx.playClick();
    room?.leave(true);
    setRoom(null);
    setState(null);
    clearStoredSession();
    setResumable(null);
  }

  if (reconnectStatus) {
    return (
      <div className="landing">
        <div className="panel center-text">
          <p>{reconnectStatus}</p>
        </div>
      </div>
    );
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
        resumable={resumable}
        onRejoinPrevious={rejoinPrevious}
      />
    );
  }

  return (
    <ArenaScreen
      state={state}
      mySessionId={mySessionId.current}
      onStart={startGame}
      onThrow={throwMove}
      onActivateAbility={activateAbility}
      onRematch={rematch}
      onLeave={leaveRoom}
      error={error}
      scoutResult={scoutResult}
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
  resumable: StoredSession | null;
  onRejoinPrevious: () => void;
}) {
  const {
    name,
    setName,
    joinCode,
    setJoinCode,
    serverUrl,
    setServerUrl,
    busy,
    error,
    onCreate,
    onJoin,
    resumable,
    onRejoinPrevious,
  } = props;

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
        {resumable && (
          <>
            <button className="btn btn-rejoin" onClick={onRejoinPrevious} disabled={busy}>
              ↩ REJOIN AS {resumable.name.toUpperCase()}
            </button>
            <div className="or-split">
              <span />
              OR START FRESH
              <span />
            </div>
          </>
        )}

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
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            placeholder="CODE"
            maxLength={4}
            className="code-input"
          />
          <button className="btn" onClick={onJoin} disabled={busy || joinCode.trim().length < 4 || !serverUrl}>
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

function placement(p: PlayerSnapshot, state: StateSnapshot): { label: string; rank: number } {
  if (state.phase === "gameover" && state.winnerName === p.name) {
    return { label: "CHAMPION", rank: 0 };
  }
  if (p.alive) {
    return { label: "In the fight", rank: 1 };
  }
  return { label: `Out - Round ${p.eliminatedRound}`, rank: -p.eliminatedRound };
}

function MuteToggle() {
  const [muted, setMutedState] = useState(() => sfx.isMuted());

  function toggle() {
    const next = !muted;
    sfx.setMuted(next);
    setMutedState(next);
    if (!next) sfx.playClick();
  }

  return (
    <button className="mute-toggle" onClick={toggle} title={muted ? "Unmute sounds" : "Mute sounds"}>
      {muted ? "🔇" : "🔊"}
    </button>
  );
}

function Leaderboard({ state }: { state: StateSnapshot }) {
  const ranked = useMemo(() => {
    return Object.entries(state.players)
      .map(([id, p]) => ({ id, p, ...placement(p, state) }))
      .sort((a, b) => b.p.wins - a.p.wins || a.rank - b.rank);
  }, [state]);

  return (
    <aside className="leaderboard">
      <h2 className="leaderboard-title">SCOREBOARD</h2>
      <ol className="leaderboard-list">
        {ranked.map(({ id, p, label, rank }, i) => (
          <li key={id} className={`leaderboard-row ${rank === 0 ? "champ" : ""} ${!p.alive && rank !== 0 ? "out" : ""}`}>
            <span className="lb-pos">{i + 1}</span>
            <span className="lb-avatar">{initials(p.name)}</span>
            <span className="lb-name">{p.name}</span>
            <span className="lb-wins" title="Tournament wins">
              🏆 {p.wins}
            </span>
            <span className="lb-status">{rank === 0 ? "🏆" : p.alive ? "🔥" : "💀"} {label === "CHAMPION" ? "" : label}</span>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function ArenaScreen(props: {
  state: StateSnapshot;
  mySessionId: string;
  onStart: () => void;
  onThrow: (m: Move) => void;
  onActivateAbility: (a: AbilityId) => void;
  onRematch: () => void;
  onLeave: () => void;
  error: string;
  scoutResult: { candidates: Move[]; opponentName: string } | null;
}) {
  const { state, mySessionId, onStart, onThrow, onActivateAbility, onRematch, onLeave, error, scoutResult } = props;
  const players = useMemo(() => Object.entries(state.players), [state.players]);
  const isHost = mySessionId === state.hostId;
  const me = state.players[mySessionId];

  useEffect(() => {
    if (state.phase === "gameover") sfx.playChampionFanfare();
  }, [state.phase, state.winnerName]);

  const activeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const d of state.duels) {
      ids.add(d.aId);
      if (d.bId) ids.add(d.bId);
    }
    return ids;
  }, [state.duels]);

  const aliveCount = players.filter(([, p]) => p.alive).length;
  const ringSize = players.length <= 2 ? 190 : 220;
  const radius = ringSize / 2;

  const myDuel = state.duels.find((d) => d.aId === mySessionId || d.bId === mySessionId);
  const myUsableCheck = useMemo(() => makeUsabilityCheck(myDuel, mySessionId), [myDuel, mySessionId]);

  return (
    <div className="game-layout">
      {state.phase === "battle" && (
        <AbilityBar abilities={me?.abilities || []} isUsable={myUsableCheck} onActivate={onActivateAbility} />
      )}

      <div className="arena">
        <div className="arena-header">
          <h1 className="brand-title small">
            RPS <span className="stroke">ROYALE</span>
          </h1>
          {state.phase !== "lobby" && state.phase !== "gameover" && (
            <div className="round-chip">{aliveCount <= 2 ? "FINAL" : `ROUND ${state.round}`}</div>
          )}
          <div className="room-code-chip">
            CODE: <strong>{state.joinCode}</strong>
            <button className="copy-btn" onClick={() => navigator.clipboard.writeText(state.joinCode)}>
              copy
            </button>
          </div>
          <MuteToggle />
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
            const isThisHost = id === state.hostId;
            return (
              <div
                key={id}
                className={`avatar-pod ${p.alive ? "alive" : "dead"} ${isMe ? "me" : ""} ${
                  activeIds.has(id) ? "active" : ""
                } ${isChampion ? "champion" : ""}`}
                style={{ transform: `translate(${x}px, ${y}px)` }}
              >
                <div className="avatar-circle">{initials(p.name)}</div>
                {id !== mySessionId && p.abilities.length > 0 && (
                  <div className="ability-count" title={`${p.abilities.length} abilit${p.abilities.length === 1 ? "y" : "ies"} held`}>
                    🎒{p.abilities.length}
                  </div>
                )}
                <div className="avatar-name">
                  {isThisHost && "👑 "}
                  {p.name}
                </div>
                {!p.connected && <div className="avatar-flag">left</div>}
              </div>
            );
          })}
        </div>

        {scoutResult && (
          <div className="scout-toast">
            {scoutResult.candidates.length === 0 ? (
              <>🔍 {scoutResult.opponentName} hasn't picked yet!</>
            ) : (
              <>
                🔍 {scoutResult.opponentName} will throw{" "}
                {scoutResult.candidates.map((m, i) => (
                  <span key={m}>
                    {i > 0 && " or "}
                    {MOVE_ICON[m]} {m}
                  </span>
                ))}
                !
              </>
            )}
          </div>
        )}

        {state.phase === "lobby" && (
          <div className="lobby-controls">
            <p className="hint-line">{players.length}/4 fighters in the arena</p>
            {isHost ? (
              <>
                <button className="btn btn-primary" onClick={onStart} disabled={players.length < 2}>
                  START TOURNAMENT
                </button>
                {players.length < 2 && <p className="hint-line">Need at least 2 to begin.</p>}
              </>
            ) : (
              <p className="hint-line">Waiting for the host to start…</p>
            )}
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
            {isHost ? (
              <button className="btn btn-primary" onClick={onRematch}>
                REMATCH
              </button>
            ) : (
              <p className="hint-line">Waiting for the host to start a rematch…</p>
            )}
          </div>
        )}

        <button className="link-btn" onClick={onLeave}>
          Leave arena
        </button>

        {error && <p className="error">{error}</p>}
      </div>

      <Leaderboard state={state} />
    </div>
  );
}

function makeUsabilityCheck(myDuel: DuelSnapshot | undefined, mySessionId: string) {
  return (abilityId: AbilityId): boolean => {
    if (!myDuel || myDuel.isBye) return false;
    const iAmA = myDuel.aId === mySessionId;
    const myMove = iAmA ? myDuel.aMove : myDuel.bMove;
    const oppMove = iAmA ? myDuel.bMove : myDuel.aMove;

    switch (abilityId) {
      case "scout":
      case "coinflip":
      case "sabotage":
        return myDuel.status === "choosing";
      case "mirror":
        return myDuel.status === "choosing" && !myMove && !!oppMove;
      case "rewind":
        return (
          myDuel.status === "resolved" &&
          !myDuel.isDraw &&
          !!myDuel.winnerId &&
          myDuel.winnerId !== mySessionId
        );
      default:
        return false;
    }
  };
}

function AbilityBar(props: {
  abilities: string[];
  isUsable: (a: AbilityId) => boolean;
  onActivate: (a: AbilityId) => void;
}) {
  const { abilities, isUsable, onActivate } = props;
  const slots = [0, 1, 2];

  return (
    <aside className="ability-bar">
      <h2 className="leaderboard-title">ABILITIES</h2>
      <div className="ability-slots">
        {slots.map((i) => {
          const abilityId = abilities[i] as AbilityId | undefined;
          if (!abilityId) {
            return (
              <div key={i} className="ability-slot empty">
                <span className="ability-slot-icon">—</span>
              </div>
            );
          }
          const info = ABILITY_INFO[abilityId];
          const usable = isUsable(abilityId);
          return (
            <button
              key={i}
              className={`ability-slot filled ${usable ? "usable" : "locked"}`}
              onClick={() => usable && onActivate(abilityId)}
              disabled={!usable}
              data-tooltip={`${info.name}: ${info.description}`}
            >
              <span className="ability-slot-icon">{info.icon}</span>
              <span className="ability-slot-name">{info.name}</span>
            </button>
          );
        })}
      </div>
      <p className="ability-hint">Earn one each round you survive.</p>
    </aside>
  );
}

type AnimStage = "idle" | "reveal" | "clash" | "aftermath";

function DuelCard(props: { duel: DuelSnapshot; mySessionId: string; onThrow: (m: Move) => void }) {
  const { duel, mySessionId, onThrow } = props;
  const [stage, setStage] = useState<AnimStage>("idle");

  useEffect(() => {
    if (duel.status !== "resolved" || duel.isBye) {
      setStage("idle");
      return;
    }
    setStage("reveal");
    sfx.playReveal();

    const amParticipant = duel.aId === mySessionId || duel.bId === mySessionId;
    const t1 = setTimeout(() => {
      setStage("clash");
      if (amParticipant && !duel.isDraw) {
        if (duel.winnerId === mySessionId) sfx.playWin();
        else sfx.playLose();
      }
    }, 550);
    const t2 = setTimeout(() => setStage("aftermath"), 1550);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [duel.status, duel.aId, duel.bId, duel.resultText, duel.isDraw, duel.winnerId, mySessionId]);

  useEffect(() => {
    if (duel.isDraw) sfx.playDraw();
  }, [duel.isDraw]);

  useEffect(() => {
    if (duel.abilityEvent) sfx.playAbility();
  }, [duel.abilityEvent]);

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

  const revealed = stage !== "idle";
  const aWon = duel.status === "resolved" && duel.winnerId === duel.aId;
  const bWon = duel.status === "resolved" && duel.winnerId === duel.bId;
  const winMove = duel.winMove as Move | "";

  return (
    <div
      className={`duel-card ${revealed ? "revealed" : ""} ${stage === "clash" ? "clashing" : ""} ${
        duel.isDraw ? "draw" : ""
      }`}
    >
      {duel.abilityEvent && (
        <div key={duel.abilityEvent} className="ability-banner">
          {duel.abilityEvent}
        </div>
      )}

      <div className="duel-row">
        <FighterSlot
          name={duel.aName}
          move={duel.aMove as Move}
          revealed={revealed}
          won={aWon}
          lost={bWon}
          stage={stage}
          side="a"
        />
        <div className="vs-stage">
          <div className="vs-badge">VS</div>
          {stage === "clash" && winMove && <div className="impact-burst">{IMPACT_ICON[winMove]}</div>}
        </div>
        <FighterSlot
          name={duel.bName}
          move={duel.bMove as Move}
          revealed={revealed}
          won={bWon}
          lost={aWon}
          stage={stage}
          side="b"
        />
      </div>

      {duel.isDraw && <p className="duel-status draw-text">DRAW — RE-THROWING…</p>}
      {duel.status === "resolved" && !duel.isDraw && stage === "aftermath" && (
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
  stage: AnimStage;
  side: "a" | "b";
}) {
  const { name, move, revealed, won, lost, stage, side } = props;
  const showLoserEffect = lost && stage === "clash";

  return (
    <div className={`fighter fighter-${side} ${won ? "won" : ""} ${lost && stage === "aftermath" ? "lost" : ""}`}>
      <div
        className={`fighter-icon ${revealed && move ? "revealed" : "hidden"} ${
          won && stage === "clash" ? `lunge-${side}` : ""
        } ${showLoserEffect && move ? `hit-${move}` : ""}`}
      >
        {revealed && move ? MOVE_ICON[move] : "❔"}
      </div>
      <div className="fighter-name">{name}</div>
    </div>
  );
}
