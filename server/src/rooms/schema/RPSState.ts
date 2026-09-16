import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";

export class Player extends Schema {
  @type("string") name: string = "";
  @type("boolean") alive: boolean = true;
  @type("boolean") connected: boolean = true;
  @type("number") eliminatedRound: number = -1;
  @type(["string"]) abilities = new ArraySchema<string>();
}

export class Duel extends Schema {
  @type("string") aId: string = "";
  @type("string") aName: string = "";
  @type("string") aMove: string = "";
  @type("string") bId: string = "";
  @type("string") bName: string = "";
  @type("string") bMove: string = "";
  @type("string") status: "choosing" | "resolved" = "choosing";
  @type("string") winnerId: string = "";
  @type("string") winMove: string = "";
  @type("string") loseMove: string = "";
  @type("string") resultText: string = "";
  @type("boolean") isBye: boolean = false;
  @type("boolean") isDraw: boolean = false;
  @type("string") abilityEvent: string = "";
}

export class RPSState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type([Duel]) duels = new ArraySchema<Duel>();
  @type("string") phase: "lobby" | "battle" | "gameover" = "lobby";
  @type("number") round: number = 0;
  @type("string") winnerName: string = "";
  @type("string") hostId: string = "";
  @type("string") joinCode: string = "";
}
