import { launchSettings, runTrial31, TRIAL31_RULES } from "@caja/core";
import { createDb, loadNearestEnvFile } from "@caja/db";

/**
 * Ajuste a la prueba de 31 días (handoff trial-31 T8). Solo cuenta por defecto; `--apply` escribe.
 * `pnpm --filter @caja/worker trial:31 [--apply]`. Lee con DATABASE_ADMIN_URL (cruza todos los
 * negocios). Imprime solo conteos por regla y los ajustes del ciclo de la prueba: nunca nombres,
 * teléfonos, correos ni ids.
 */
loadNearestEnvFile();
const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_ADMIN_URL no definida");
  process.exit(2);
}
const apply = process.argv.slice(2).includes("--apply");
const { db, close } = createDb(url, { max: 1 });

(async () => {
  const now = new Date();
  const counts = await runTrial31(db, { now, apply });
  console.log(
    `\n== trial:31 ${apply ? "--apply (escribió)" : "dry-run (no cambió nada)"} · ${now.toISOString()}`,
  );
  console.table(
    TRIAL31_RULES.map((rule) => ({
      regla: rule,
      total: counts[rule].total,
      internas: counts[rule].internal,
    })),
  );
  const changed =
    counts.extender_en_curso.total +
    counts.extender_en_gracia.total +
    counts.reabrir_suspendido.total;
  console.log(`${apply ? "Cambiados" : "Se cambiarían"}: ${changed}`);
  const l = await launchSettings(db);
  console.log(`Ciclo de la prueba: beta=${l.beta} surveyDay=${l.surveyDay} valueDay=${l.valueDay}`);
  await close();
})().catch(async (err) => {
  console.error(err);
  await close();
  process.exit(1);
});
