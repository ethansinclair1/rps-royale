import { Room, Client } from "colyseus";
import { RPSState, Player } from "./schema/RPSState";

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

const MAX_PLAYERS = 4;
const MIN_PLAYERS_TO_START = 2;

export class RPSRoyaleRoom extends Room<RPSState> {
  maxClients = MAX_PLAYERS;

  onCreate() {
    this.setState(new RPSState());

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
    this.state.log.push(`${player.name} joined.`);
  }

  onLeave(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    if (this.state.phase === "lobby") {
      this.state.players.delete(client.sessionId);
      return;
    }

    player.connected = false;
    if (player.alive) {
      player.alive = false;
      this.state.log.push(`${player.name} disconnected and is out.`);
    }

    if (!this.checkForWinner()) {
      this.checkRoundComplete();
    }
  }

  private handleStart(client: Client) {
    if (this.state.phase !== "lobby") return;
    if (!this.state.players.has(client.sessionId)) return;
    if (this.state.players.size < MIN_PLAYERS_TO_START) return;
    this.startRound();
  }

  private handleMove(client: Client, message: unknown) {
    const player = this.state.players.get(client.sessionId);
    if (!player || !player.alive) return;
    if (this.state.phase !== "choosing") return;
    if (player.move) return;

    const move = (message as { move?: unknown } | undefined)?.move;
    if (!isMove(move)) return;

    player.move = move;
    this.checkRoundComplete();
  }

  private handleRematch(client: Client) {
    if (this.state.phase !== "gameover") return;
    if (!this.state.players.has(client.sessionId)) return;

    for (const p of this.state.players.values()) {
      p.alive = true;
      p.move = "";
    }
    this.state.phase = "lobby";
    this.state.round = 0;
    this.state.winnerName = "";
    this.state.log.push("Rematch! Waiting for players to start.");
  }

  private startRound() {
    this.state.phase = "choosing";
    this.state.round += 1;
    for (const p of this.state.players.values()) {
      if (p.alive) p.move = "";
    }
    this.state.log.push(`Round ${this.state.round} - choose your move!`);
  }

  private checkRoundComplete() {
    if (this.state.phase !== "choosing") return;

    const alivePlayers = [...this.state.players.values()].filter((p) => p.alive);
    if (alivePlayers.length === 0) return;
    if (!alivePlayers.every((p) => p.move)) return;

    this.resolveRound(alivePlayers);
  }

  private resolveRound(alivePlayers: Player[]) {
    const uniqueMoves = [...new Set(alivePlayers.map((p) => p.move as Move))];

    if (uniqueMoves.length === 1) {
      this.state.log.push(`Everyone threw ${uniqueMoves[0]} - draw, replay!`);
      this.startRound();
      return;
    }

    if (uniqueMoves.length === 3) {
      this.state.log.push("Rock, paper, and scissors all appeared - draw, replay!");
      this.startRound();
      return;
    }

    const [moveA, moveB] = uniqueMoves;
    const winningMove = beats(moveA, moveB) ? moveA : moveB;
    const losingMove = winningMove === moveA ? moveB : moveA;

    const eliminated = alivePlayers.filter((p) => p.move === losingMove);
    for (const p of eliminated) p.alive = false;

    this.state.log.push(
      `${winningMove} beats ${losingMove} - ${eliminated.map((p) => p.name).join(", ")} eliminated!`
    );

    if (this.checkForWinner()) return;

    this.startRound();
  }

  private checkForWinner(): boolean {
    if (this.state.phase === "gameover") return true;

    const remaining = [...this.state.players.values()].filter((p) => p.alive);
    if (remaining.length <= 1) {
      this.state.phase = "gameover";
      this.state.winnerName = remaining[0]?.name ?? "Nobody";
      this.state.log.push(
        remaining.length === 1
          ? `${remaining[0].name} wins RPS Royale!`
          : "Game over - no survivors."
      );
      return true;
    }
    return false;
  }
}
