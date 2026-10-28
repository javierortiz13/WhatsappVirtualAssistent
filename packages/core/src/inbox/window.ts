import { and, desc, eq, schema, type Tx } from "@caja/db";

/**
 * Ventana de servicio de Meta (PRD hábitos US-202): Rocco puede escribir texto libre hasta 24 h
 * después del último mensaje entrante del teléfono (cualquier tipo, toques incluidos). Se usa un
 * margen de 30 min para no mandar justo al cierre. Un solo lugar, un solo margen.
 */
export const WINDOW_MS = 24 * 3_600_000;
export const WINDOW_SAFE_MS = 23.5 * 3_600_000;

/** ¿Sigue abierta la ventana, con el margen? */
export function windowOpenAt(lastInboundAt: Date | null, now: Date): boolean {
  return lastInboundAt !== null && now.getTime() - lastInboundAt.getTime() < WINDOW_SAFE_MS;
}

export type ServiceWindow = {
  lastInboundAt: Date | null;
  /** Cuándo cierra de verdad (24 h); null si nunca escribió. */
  closesAt: Date | null;
  open: boolean;
};

export async function serviceWindow(tx: Tx, phoneId: string, now: Date): Promise<ServiceWindow> {
  const [last] = await tx
    .select({ at: schema.message.createdAt })
    .from(schema.message)
    .where(and(eq(schema.message.phoneId, phoneId), eq(schema.message.direction, "in")))
    .orderBy(desc(schema.message.createdAt))
    .limit(1);
  const lastInboundAt = last?.at ?? null;
  return {
    lastInboundAt,
    closesAt: lastInboundAt ? new Date(lastInboundAt.getTime() + WINDOW_MS) : null,
    open: windowOpenAt(lastInboundAt, now),
  };
}
