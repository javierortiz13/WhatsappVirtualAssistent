import { BATCH_CAP, BatchRefused, planSignupBatch, readQuality, runSignupBatch } from "@caja/core";
import { MetaClient } from "@caja/core/whatsapp";
import { createDb, loadNearestEnvFile } from "@caja/db";

/**
 * Plantilla del registro sin terminar, un solo lote (PRD signup-reminders v1.2, US-SR-08, 3B).
 * Se corre en Railway, para que el token de Meta no viva en una laptop:
 *   railway run --service worker pnpm --filter @caja/worker signup:rescue            (solo cuenta)
 *   railway run --service worker pnpm --filter @caja/worker signup:rescue --apply --confirm <N>
 * Opciones: --interval-s <s> (90; menos de 60 se niega), --max-age-days <d> (30),
 * --include-holdout (se niega mientras holdoutPct > 0).
 * Nunca imprime un número ni un nombre. Salida: 0 bien, 2 se negó, 3 se paró por la regla S1–S7.
 */
loadNearestEnvFile();
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (name: string, fallback: number) => {
  const v = value(name);
  return v === undefined ? fallback : Number(v);
};

const env = process.env;
const missing = [
  "DATABASE_URL",
  "META_ACCESS_TOKEN",
  "META_PHONE_NUMBER_ID",
  "META_SIGNUP_TEMPLATE",
]
  .filter((k) => !env[k])
  .join(", ");
if (missing) {
  console.error(`faltan variables: ${missing}`);
  process.exit(2);
}
const rateUsd = Number(env.META_MARKETING_RATE_USD ?? "0.074");
const template = {
  name: env.META_SIGNUP_TEMPLATE as string,
  language: env.META_TEMPLATE_LANGUAGE ?? "es",
  wabaId: env.META_WABA_ID ?? null,
};
const parkNumbers = (env.SIGNUP_PARK_NUMBERS ?? "").split(",").filter(Boolean);
const meta = new MetaClient({
  accessToken: env.META_ACCESS_TOKEN as string,
  phoneNumberId: env.META_PHONE_NUMBER_ID as string,
  graphVersion: env.META_GRAPH_VERSION ?? "v24.0",
});
// El rol de la app (caja_app), nunca el administrador: lee registros de personas.
const { db, close } = createDb(env.DATABASE_URL as string, { max: 1 });
const read = (v: string | null) => v ?? "no se pudo leer";

(async () => {
  try {
    if (!flag("--apply")) {
      const plan = await planSignupBatch(db, {
        now: new Date(),
        maxAgeDays: num("--max-age-days", 30),
        parkNumbers,
        includeHoldout: flag("--include-holdout"),
        rateUsd,
      });
      const q = await readQuality(meta, template);
      console.log("Registro: plantilla (lote único). SOLO CUENTA, no se envió nada.");
      console.log(`Registros sin terminar: ${plan.unfinished}`);
      console.log("Excluidos por motivo:");
      for (const [k, n] of Object.entries(plan.excluded)) console.log(`  ${k}: ${n}`);
      console.log("Elegibles por paso:");
      for (const [k, n] of Object.entries(plan.eligibleByStep)) console.log(`  ${k}: ${n}`);
      console.log(`Elegibles: ${plan.eligible} · a enviar (tope ${BATCH_CAP}): ${plan.toSend}`);
      console.log(`Quedarían fuera por el tope: ${plan.leftOutByCap}`);
      console.log(`Costo estimado: $${plan.costUsd.toFixed(2)} (a $${rateUsd} cada una)`);
      console.log(
        `Plantilla: estado ${read(q.templateStatus)} · categoría ${read(q.templateCategory)} · calidad ${read(q.templateQuality)}`,
      );
      console.log(
        `Número: calidad ${read(q.phoneQuality)} · límite de mensajes ${read(q.messagingLimit)}`,
      );
      console.log(`Para enviar: --apply --confirm ${plan.toSend}`);
      return;
    }
    const confirm = value("--confirm");
    const r = await runSignupBatch(db, meta, {
      template,
      confirm: confirm === undefined ? null : Number(confirm),
      intervalS: num("--interval-s", 90),
      maxAgeDays: num("--max-age-days", 30),
      parkNumbers,
      includeHoldout: flag("--include-holdout"),
      rateUsd,
      now: () => new Date(),
      sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)),
      log: (line) => console.log(line),
    });
    console.log(`Enviados: ${r.sent} · retenidos por Meta: ${r.held}`);
    console.log(`Fallidos por código: ${JSON.stringify(r.failedByCode)}`);
    console.log(`«No me escribas» durante la corrida: ${r.optOuts}`);
    console.log(`Sin enviar: ${r.unsent} · costo estimado: $${r.costUsd.toFixed(2)}`);
    if (r.qualityUnreadable) console.log("Calidad: no se pudo leer (revisar WhatsApp Manager).");
    if (r.stop) {
      console.log(`PARADA: ${r.stop}`);
      process.exitCode = 3;
    } else console.log("Terminó sin parada.");
  } catch (err) {
    if (err instanceof BatchRefused) {
      console.error(`No se envió nada: ${err.reason}`);
      process.exitCode = 2;
    } else {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  } finally {
    await close();
  }
})();
