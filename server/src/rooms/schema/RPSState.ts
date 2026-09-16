import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";

export class Player extends Schema {
  @type("string") name: string = "";
  @type("boolean") alive: boolean = true;
  @type("string") move: string = "";
  @type("boolean") connected: boolean = true;
}

export class RPSState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type("string") phase: "lobby" | "choosing" | "gameover" = "lobby";
  @type("number") round: number = 0;
  @type(["string"]) log = new ArraySchema<string>();
  @type("string") winnerName: string = "";
}
