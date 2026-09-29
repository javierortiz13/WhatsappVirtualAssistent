import { sql } from "drizzle-orm";
import { z } from "zod";
import { createDb, rows, withTenant } from "../client";
import { loadNearestEnvFile } from "../env-file";
import { phoneNumber } from "../schema/index";

/**
 * Alta de un teléfono en el negocio de un dueño, sin dashboard (S1). Uso:
 *   pnpm --filter @caja/db phone:add -- --owner 17869660391 --phone 584141234567 --role employee --name Carlos
 * Corre con el rol de aplicación: ubica el tenant con `app.resolve_phone` y escribe bajo RLS.
 */
const Args = z.object({
  owner: z.string().regex(/^\d{8,15}$/),
  phone: z.string().regex(/^\d{8,15}$/),
  role: z.enum(["owner", "employee"]).default("employee"),
  name: z.string().optional(),
});

export async function addPhone(
  db: ReturnType<typeof createDb>["db"],
  input: z.infer<typeof Args>,
): Promise<{ tenantId: string; phoneId: string; created: boolean }> {
  const [owner] = rows<{ tenant_id: string; role: string }>(
    await db.execute(sql`select tenant_id, role from app.resolve_phone(${input.owner}, null)`),
  );
  if (!owner) throw new Error(`el número ${input.owner} no pertenece a ningún negocio`);
  if (owner.role !== "owner") throw new Error(`el número ${input.owner} no es de un dueño`);
  const [existing] = rows<{ tenant_id: string }>(
    await db.execute(sql`select tenant_id from app.resolve_phone(${input.phone}, null)`),
  );
  if (existing && existing.tenant_id !== owner.tenant_id)
    throw new Error(`el número ${input.phone} ya está en otro negocio`);
  return withTenant(db, owner.tenant_id, async (tx) => {
    if (existing) {
      const [row] = await tx
        .update(phoneNumber)
        .set({ role: input.role, status: "active", displayName: input.name ?? null })
        .where(sql`${phoneNumber.e164} = ${input.phone}`)
        .returning({ id: phoneNumber.id });
      return { tenantId: owner.tenant_id, phoneId: row?.id ?? "", created: false };
    }
    const [row] = await tx
      .insert(phoneNumber)
      .values({
        tenantId: owner.tenant_id,
        e164: input.phone,
        role: input.role,
        status: "active",
        displayName: input.name ?? null,
        verifiedAt: new Date(),
      })
      .returning({ id: phoneNumber.id });
    return { tenantId: owner.tenant_id, phoneId: row?.id ?? "", created: true };
  });
}

function parseArgv(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[a.slice(2)] = next;
        i++;
      } else out[a.slice(2)] = "true";
    }
  }
  return out;
}

async function main() {
  loadNearestEnvFile();
  const input = Args.parse(parseArgv(process.argv.slice(2)));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL no definida");
  const { db, close } = createDb(url, { max: 1 });
  try {
    const r = await addPhone(db, input);
    console.log(
      `${r.created ? "creado" : "actualizado"}: ${input.phone} como ${input.role} en el tenant ${r.tenantId}`,
    );
  } finally {
    await close();
  }
}

const isMain =
  process.argv[1]?.endsWith("add-phone.ts") || process.argv[1]?.endsWith("add-phone.js");
if (isMain) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
