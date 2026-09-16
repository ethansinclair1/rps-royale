import { Room, Client } from "colyseus";
import type { Delayed } from "@gamestdio/timer";
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

function generateRejoinToken(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

const ABILITY_IDS = ["scout", "mirror", "rewind", "coinflip", "sabotage"] as const;
type AbilityId = (typeof ABILITY_IDS)[number];

function isAbilityId(value: unknown): value is AbilityId {
  return typeof value === "string" && (ABILITY_IDS as readonly string[]).includes(value);
}

function randomAbility(): AbilityId {
  return ABILITY_IDS[Math.floor(Math.random() * ABILITY_IDS.length)];
}

const MAX_PLAYERS = 4;
const MIN_PLAYERS_TO_START = 2;
const MAX_ABILITY_SLOTS = 3;
const REVEAL_DELAY_MS = 4500;
const DRAW_RESET_DELAY_MS = 2200;
const ABILITY_EVENT_DISPLAY_MS = 2200;
// How long a disconnected player's seat is held open before they're eliminated
// for good. Generous on purpose - covers a backgrounded tab, a page reload, or
// a slow host (e.g. Render free tier) waking back up.
const REJOIN_WINDOW_MS = 45000;

interface RoomMetadata {
  code: string;
}

export class RPSRoyaleRoom extends Room<RPSState, RoomMetadata> {
  maxClients = MAX_PLAYERS;
  private advanceScheduled = false;
  private advanceTimeout: Delayed | null = null;
  // Maps an opaque rejoin token (known only to the room and the owning client)
  // to whichever sessionId currently holds that player's seat in state.players.
  // Not part of the replicated schema - never sent to other clients.
  private rejoinTokens = new Map<string, string>();

  async onCreate(options: { forcedCode?: string } = {}) {
    this.setState(new RPSState());

    // A Discord Activity instance passes its own stable instanceId here so
    // everyone in the same voice channel lands in the same room automatically,
    // instead of a random human-friendly code.
    const code = (options.forcedCode || "").slice(0, 32) || generateJoinCode();
    this.state.joinCode = code;
    await this.setMetadata({ code });

    this.onMessage("start", (client) => this.handleStart(client));
    this.onMessage("move", (client, message) => this.handleMove(client, message));
    this.onMessage("rematch", (client) => this.handleRematch(client));
    this.onMessage("ability", (client, message) => this.handleAbility(client, message));
  }

  onJoin(client: Client, options: { name?: string; rejoinToken?: string } = {}) {
    const rejoinToken = options.rejoinToken;
    if (rejoinToken) {
      const rebound = this.tryRebindSeat(client, rejoinToken);
      if (rebound) return;
    }

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

    const token = generateRejoinToken();
    this.rejoinTokens.set(token, client.sessionId);
    client.send("rejoin-token", { token });
  }

  private tryRebindSeat(client: Client, rejoinToken: string): boolean {
    const oldId = this.rejoinTokens.get(rejoinToken);
    if (!oldId || oldId === client.sessionId) return false;

    const player = this.state.players.get(oldId);
    if (!player) return false;

    this.state.players.delete(oldId);
    this.state.players.set(client.sessionId, player);
    player.connected = true;

    if (this.state.hostId === oldId) {
      this.state.hostId = client.sessionId;
    }

    for (const duel of this.state.duels) {
      if (duel.aId === oldId) duel.aId = client.sessionId;
      if (duel.bId === oldId) duel.bId = client.sessionId;
      if (duel.winnerId === oldId) duel.winnerId = client.sessionId;
    }

    this.rejoinTokens.set(rejoinToken, client.sessionId);
    client.send("rejoin-token", { token: rejoinToken });
    return true;
  }

  onLeave(client: Client, consented?: boolean) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    if (this.state.phase === "lobby") {
      this.state.players.delete(client.sessionId);
      this.reassignHostIfNeeded(client.sessionId);
      return;
    }

    player.connected = false;

    if (consented) {
      // Intentional "Leave arena" - don't make their opponent wait around.
      this.eliminateIfStillGone(client.sessionId);
      return;
    }

    // Unexpected drop - hold their seat open in case they rejoin with their token.
    this.clock.setTimeout(() => this.eliminateIfStillGone(client.sessionId), REJOIN_WINDOW_MS);
  }

  private eliminateIfStillGone(sessionId: string) {
    // If this sessionId no longer holds the seat, they successfully rejoined
    // under a new connection - nothing to do. Same if they're back online.
    const current = this.state.players.get(sessionId);
    if (!current || current.connected || !current.alive) return;

    for (const duel of this.state.duels) {
      if (duel.status !== "choosing") continue;
      if (duel.aId === sessionId) {
        this.resolveForfeit(duel, duel.bId, duel.bName, duel.aName);
      } else if (duel.bId === sessionId) {
        this.resolveForfeit(duel, duel.aId, duel.aName, duel.bName);
      }
    }

    current.alive = false;
    current.eliminatedRound = this.state.round;
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

  private findActiveDuel(sessionId: string): Duel | undefined {
    return this.state.duels.find((d) => d.aId === sessionId || d.bId === sessionId);
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

  private handleAbility(client: Client, message: unknown) {
    if (this.state.phase !== "battle") return;

    const abilityId = (message as { abilityId?: unknown } | undefined)?.abilityId;
    if (!isAbilityId(abilityId)) return;

    const player = this.state.players.get(client.sessionId);
    if (!player || !player.alive) return;

    const slotIndex = player.abilities.indexOf(abilityId);
    if (slotIndex === -1) return;

    const duel = this.findActiveDuel(client.sessionId);
    if (!duel || duel.isBye) return;

    const isA = duel.aId === client.sessionId;
    const myMove = isA ? duel.aMove : duel.bMove;
    const oppMove = isA ? duel.bMove : duel.aMove;
    const oppName = isA ? duel.bName : duel.aName;

    switch (abilityId as AbilityId) {
      case "scout": {
        // Narrows the opponent's move down to 2 of 3 possibilities - never
        // reveals it outright, so you still have to make a real guess.
        if (duel.status !== "choosing") return;
        player.abilities.splice(slotIndex, 1);
        this.fireAbilityEvent(duel, `🔍 ${player.name} used SCOUT!`);
        if (!oppMove) {
          client.send("scout-result", { candidates: [], opponentName: oppName });
          return;
        }
        const notThrown = MOVES.filter((m) => m !== oppMove);
        const excluded = notThrown[Math.floor(Math.random() * notThrown.length)];
        const candidates = MOVES.filter((m) => m !== excluded);
        client.send("scout-result", { candidates, opponentName: oppName });
        return;
      }

      case "mirror": {
        if (duel.status !== "choosing" || myMove || !oppMove) return;
        if (isA) duel.aMove = oppMove;
        else duel.bMove = oppMove;
        player.abilities.splice(slotIndex, 1);
        this.fireAbilityEvent(duel, `🪞 ${player.name} used MIRROR!`);
        if (duel.aMove && duel.bMove) this.resolveDuel(duel);
        return;
      }

      case "rewind": {
        if (duel.status !== "resolved" || duel.isDraw) return;
        if (duel.winnerId === client.sessionId) return; // only the loser can rewind
        this.cancelScheduledAdvance();
        duel.status = "choosing";
        duel.winnerId = "";
        duel.winMove = "";
        duel.loseMove = "";
        duel.resultText = "";
        duel.aMove = "";
        duel.bMove = "";
        player.abilities.splice(slotIndex, 1);
        this.fireAbilityEvent(duel, `⏪ ${player.name} used REWIND!`);
        return;
      }

      case "coinflip": {
        // Genuine 50/50 - this can just as easily lose you the duel outright.
        if (duel.status !== "choosing") return;
        const oppId = isA ? duel.bId : duel.aId;
        const iWinFlip = Math.random() < 0.5;
        duel.winnerId = iWinFlip ? client.sessionId : oppId;
        duel.winMove = "coinflip";
        duel.loseMove = "";
        duel.resultText = iWinFlip
          ? `${player.name} flips a coin and wins!`
          : `${player.name} flips a coin and loses!`;
        duel.status = "resolved";
        player.abilities.splice(slotIndex, 1);
        this.fireAbilityEvent(duel, `🎲 ${player.name} used COIN FLIP!`);
        this.checkRoundComplete();
        return;
      }

      case "sabotage": {
        // Steals a random ability from your opponent's inventory. Doesn't
        // touch the current duel at all - pure resource denial.
        if (duel.status !== "choosing") return;
        const oppId = isA ? duel.bId : duel.aId;
        const opponent = this.state.players.get(oppId);
        player.abilities.splice(slotIndex, 1);
        if (opponent && opponent.abilities.length > 0) {
          const stolenIdx = Math.floor(Math.random() * opponent.abilities.length);
          const stolen = opponent.abilities[stolenIdx] ?? "an ability";
          opponent.abilities.splice(stolenIdx, 1);
          this.fireAbilityEvent(duel, `🔧 ${player.name} sabotaged ${oppName}'s ${stolen.toUpperCase()}!`);
        } else {
          this.fireAbilityEvent(duel, `🔧 ${player.name} tried to sabotage ${oppName} - nothing to take!`);
        }
        return;
      }
    }
  }

  private fireAbilityEvent(duel: Duel, text: string) {
    duel.abilityEvent = text;
    this.clock.setTimeout(() => {
      if (duel.abilityEvent === text) duel.abilityEvent = "";
    }, ABILITY_EVENT_DISPLAY_MS);
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
      p.abilities.clear();
    }
    this.state.duels.clear();
    this.state.phase = "lobby";
    this.state.round = 0;
    this.state.winnerName = "";
    this.advanceScheduled = false;
  }

  private cancelScheduledAdvance() {
    this.advanceTimeout?.clear();
    this.advanceTimeout = null;
    this.advanceScheduled = false;
  }

  private checkRoundComplete() {
    if (this.state.phase !== "battle") return;
    if (this.advanceScheduled) return;
    if (this.state.duels.some((d) => d.status !== "resolved")) return;

    this.advanceScheduled = true;
    this.advanceTimeout = this.clock.setTimeout(() => {
      this.advanceScheduled = false;
      this.advanceTimeout = null;
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
      if (champ) champ.wins += 1;
      return;
    }

    // Reward survivors with a new ability for making it through the round.
    for (const id of winners) {
      const p = this.state.players.get(id);
      if (p && p.abilities.length < MAX_ABILITY_SLOTS) {
        p.abilities.push(randomAbility());
      }
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
