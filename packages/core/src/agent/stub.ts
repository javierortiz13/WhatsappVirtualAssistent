import { es } from "../render/index";
import type { AgentRunner } from "./types";

/** Sin proveedor de LLM configurado: todo lo que no es un handler determinista recibe el menú. */
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
