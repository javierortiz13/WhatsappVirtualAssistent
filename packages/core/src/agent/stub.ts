import { es } from "../render/index";
import type { AgentRunner } from "./types";

/** Hasta el día 5: todo lo que no es un handler determinista recibe el menú de fuera de alcance. */
export const stubAgent: AgentRunner = {
  async run() {
    return {
      outbound: [es.outOfScope()],
      toolCalls: [],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: null,
      status: "rejected_out_of_scope",
    };
  },
};
