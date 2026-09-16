import { Room, Client } from "colyseus";
import { RPSState, Player, Duel } from "./schema/RPSState";

const MOVES = ["rock", "paper", "scissors"] as const;
type Move = (typeof MOVES)[number];

function isMove(value: unknown): value is Move {
  return typeof value === "string" && (MOVES as readonly string[]).includes(value);
}

// Returns true if `a` beats `b` under standard rock-paper-scissors rules.
function beats(a: Move, b: Move): boolean {
  return (
    (a === "rock" && b === "scissors") ||
    (a === "scissors" && b === "paper") ||
    (a === "paper" && b === "rock")
  );
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Avoids visually ambiguous characters (0/O, 1/I/L) in join codes.
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateJoinCode(length = 4): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

const MAX_PLAYERS = 4;
const MIN_PLAYERS_TO_START = 2;
const REVEAL_DELAY_MS = 4500;
const DRAW_RESET_DELAY_MS = 2200;
const RECONNECTION_GRACE_SECONDS = 25;

interface RoomMetadata {
  code: string;
}

export class RPSRoyaleRoom extends Room<RPSState, RoomMetadata> {
  maxClients = MAX_PLAYERS;
  private advanceScheduled = false;

  async onCreate() {
    this.setState(new RPSState());

    const code = generateJoinCode();
    this.state.joinCode = code;
    await this.setMetadata({ code });

    this.onMessage("start", (client) => this.handleStart(client));
    this.onMessage("move", (client, message) => this.handleMove(client, message));
    this.onMessage("rematch", (client) => this.handleRematch(client));
  }

  onJoin(client: Client, options: { name?: string } = {}) {
    if (this.state.phase !== "lobby") {
      throw new Error("Game already in progress");
    }

    const player = new Player();
    const requestedName = (options.name || "").trim();
    player.name = (requestedName || `Player ${this.state.players.size + 1}`).slice(0, 16);
    this.state.players.set(client.sessionId, player);

    if (!this.state.hostId) {
      this.state.hostId = client.sessionId;
    }
  }

  async onLeave(client: Client, consented?: boolean) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    if (this.state.phase === "lobby") {
      this.state.players.delete(client.sessionId);
      this.reassignHostIfNeeded(client.sessionId);
      return;
    }

    player.connected = false;

    if (!consented) {
      try {
        await this.allowReconnection(client, RECONNECTION_GRACE_SECONDS);
        player.connected = true;
        return;
      } catch {
        // Reconnection window expired - treat as a real departure below.
      }
    }

    if (!player.alive) return;

    for (const duel of this.state.duels) {
      if (duel.status !== "choosing") continue;
      if (duel.aId === client.sessionId) {
        this.resolveForfeit(duel, duel.bId, duel.bName, duel.aName);
      } else if (duel.bId === client.sessionId) {
        this.resolveForfeit(duel, duel.aId, duel.aName, duel.bName);
      }
    }

    player.alive = false;
    player.eliminatedRound = this.state.round;
    this.checkRoundComplete();
  }

  private reassignHostIfNeeded(leftId: string) {
    if (this.state.hostId !== leftId) return;
    const next = [...this.state.players.keys()][0];
    this.state.hostId = next ?? "";
  }

  private handleStart(client: Client) {
    if (this.state.phase !== "lobby") return;
    if (client.sessionId !== this.state.hostId) return;
    if (this.state.players.size < MIN_PLAYERS_TO_START) return;

    this.state.phase = "battle";
    this.buildRound(shuffle([...this.state.players.keys()]));
  }

  private handleMove(client: Client, message: unknown) {
    if (this.state.phase !== "battle") return;

    const move = (message as { move?: unknown } | undefined)?.move;
    if (!isMove(move)) return;

    const duel = this.state.duels.find(
      (d) =>
        d.status === "choosing" &&
        ((d.aId === client.sessionId && !d.aMove) || (d.bId === client.sessionId && !d.bMove))
    );
    if (!duel) return;

    if (duel.aId === client.sessionId) duel.aMove = move;
    else duel.bMove = move;

    if (duel.aMove && duel.bMove) {
      this.resolveDuel(duel);
    }
  }

  private resolveDuel(duel: Duel) {
    const a = duel.aMove as Move;
    const b = duel.bMove as Move;

    if (a === b) {
      duel.isDraw = true;
      this.clock.setTimeout(() => {
        duel.aMove = "";
        duel.bMove = "";
        duel.isDraw = false;
      }, DRAW_RESET_DELAY_MS);
      return;
    }

    const aWins = beats(a, b);
    duel.winnerId = aWins ? duel.aId : duel.bId;
    duel.winMove = aWins ? a : b;
    duel.loseMove = aWins ? b : a;
    duel.resultText = `${duel.winMove} beats ${duel.loseMove}`;
    duel.status = "resolved";

    this.checkRoundComplete();
  }

  private resolveForfeit(duel: Duel, winnerId: string, winnerName: string, leaverName: string) {
    duel.winnerId = winnerId;
    duel.resultText = `${leaverName} left - ${winnerName} wins by forfeit`;
    duel.status = "resolved";
  }

  private handleRematch(client: Client) {
    if (this.state.phase !== "gameover") return;
    if (!this.state.players.has(client.sessionId)) return;

    for (const p of this.state.players.values()) {
      p.alive = true;
      p.eliminatedRound = -1;
    }
    this.state.duels.clear();
    this.state.phase = "lobby";
    this.state.round = 0;
    this.state.winnerName = "";
    this.advanceScheduled = false;
  }

  private checkRoundComplete() {
    if (this.state.phase !== "battle") return;
    if (this.advanceScheduled) return;
    if (this.state.duels.some((d) => d.status !== "resolved")) return;

    this.advanceScheduled = true;
    this.clock.setTimeout(() => {
      this.advanceScheduled = false;
      this.advanceRound();
    }, REVEAL_DELAY_MS);
  }

  private advanceRound() {
    const winners: string[] = [];

    for (const duel of this.state.duels) {
      const loserId = duel.winnerId === duel.aId ? duel.bId : duel.aId;
      if (loserId) {
        const loser = this.state.players.get(loserId);
        if (loser) {
          loser.alive = false;
          loser.eliminatedRound = this.state.round;
        }
      }

      const winner = this.state.players.get(duel.winnerId);
      if (winner?.alive) {
        winners.push(duel.winnerId);
      }
    }

    if (winners.length <= 1) {
      const champ = this.state.players.get(winners[0]);
      this.state.phase = "gameover";
      this.state.winnerName = champ?.name ?? "Nobody";
      return;
    }

    this.buildRound(shuffle(winners));
  }

  private buildRound(ids: string[]) {
    this.state.round += 1;
    this.state.duels.clear();

    for (let i = 0; i < ids.length; i += 2) {
      const aId = ids[i];
      const bId = ids[i + 1] as string | undefined;

      const duel = new Duel();
      duel.aId = aId;
      duel.aName = this.state.players.get(aId)?.name ?? "?";

      if (bId) {
        duel.bId = bId;
        duel.bName = this.state.players.get(bId)?.name ?? "?";
      } else {
        duel.isBye = true;
        duel.status = "resolved";
        duel.winnerId = aId;
        duel.resultText = `${duel.aName} advances (bye)`;
      }

      this.state.duels.push(duel);
    }

    this.checkRoundComplete();
  }
}
