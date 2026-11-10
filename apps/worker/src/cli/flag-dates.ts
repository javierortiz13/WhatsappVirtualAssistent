import { FLAG_DATE_KEYS, flagOnDates } from "@caja/core";
import { createDb, loadNearestEnvFile } from "@caja/db";

/**
 * Cuándo se encendieron Puntos (xp), Premios (rewards), Invitaciones (referrals) y el mensaje de la
 * noche para todos (dailyClose), y desde dónde (10/11, A-0038 y A-0039). Solo lee.
 * `pnpm --filter @caja/worker flags:dates`. Imprime solo fechas y «/admin» o «sistema»: nunca
 * correos, nombres, teléfonos ni ids.
 */
loadNearestEnvFile();
const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_ADMIN_URL no definida");
  process.exit(2);
}
const { db, close } = createDb(url, { max: 1 });
const NAME = {
  xp: "Puntos",
  rewards: "Premios",
  referrals: "Invitaciones",
  dailyClose: "8 pm para todos",
};

(async () => {
  const r = await flagOnDates(db);
  console.log(`\n== flags:dates · ${new Date().toISOString()} (UTC)`);
  console.table(
    FLAG_DATE_KEYS.map((k) => {
      const f = r.flags.find((x) => x.flag === k);
      return {
        interruptor: NAME[k],
        ahora: f?.on ? "encendido" : "apagado",
        "primer encendido (historial)": f?.firstOn ? `${f.firstOn.at} · ${f.firstOn.by}` : "—",
        "último encendido": f?.lastOn ? `${f.lastOn.at} · ${f.lastOn.by}` : "—",
        "último apagado": f?.lastOff ? `${f.lastOff.at} · ${f.lastOff.by}` : "—",
        "día guardado": f?.savedDay ?? "—",
        "primera huella": f?.firstTrace ?? "—",
      };
    }),
  );
  const c = r.lastChange;
  console.log(
    `Último cambio de interruptores: ${c.habits ? `${c.habits.at} · ${c.habits.by}` : "—"}. De puntos y regalos: ${c.rewards ? `${c.rewards.at} · ${c.rewards.by}` : "—"}.`,
  );
  console.log(
    "El historial existe desde el deploy de G1-4; antes, valen el día guardado y la primera huella.",
  );
  await close();
})().catch(async (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  await close();
  process.exit(1);
});
