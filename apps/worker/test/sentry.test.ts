import { QUEUES } from "@caja/db/queue";
import { describe, expect, it } from "vitest";
import { jobErrorContext } from "../src/sentry";

/** La alerta de Sentry de mensajes entrantes que fallan (10/11, para que el 07/11 se vea en minutos). */
describe("jobErrorContext", () => {
  it("un mensaje entrante que falla lleva alert=inbound_failed; el último intento es fatal", () => {
    expect(jobErrorContext(QUEUES.processMessage)).toEqual({
      tags: { queue: QUEUES.processMessage, alert: "inbound_failed", final: "no" },
      level: "error",
    });
    expect(jobErrorContext(QUEUES.processMessage, true)).toEqual({
      tags: { queue: QUEUES.processMessage, alert: "inbound_failed", final: "yes" },
      level: "fatal",
    });
  });
  it("las otras colas no disparan esa alerta", () => {
    expect(jobErrorContext(QUEUES.housekeeping)).toEqual({
      tags: { queue: QUEUES.housekeeping },
      level: "error",
    });
  });
});
