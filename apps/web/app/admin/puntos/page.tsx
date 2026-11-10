import { habitSettings } from "@caja/core";
import { loadPoints, loadReferrals } from "@/lib/admin";
import { db } from "@/lib/db";
import { getAdmin, getNow, getTenants } from "../data";
import { errorText, OK, type SectionParams } from "../messages";
import { PuntosView } from "../views/puntos";

/** /admin/puntos: todo lo de «Puntos y premios»; los interruptores están en Interruptores. */
export default async function AdminPuntos({
  searchParams,
}: {
  searchParams: Promise<SectionParams>;
}) {
  await getAdmin();
  const sp = await searchParams;
  const now = getNow();
  const tenants = await getTenants();
  const [flags, points, refs] = await Promise.all([
    habitSettings(db()),
    loadPoints(tenants, now),
    loadReferrals(tenants, now),
  ]);
  return (
    <PuntosView
      banner={{ ok: sp.ok ? (OK[sp.ok] ?? null) : null, error: errorText(sp.error) }}
      flags={{ xp: flags.xp, rewards: flags.rewards, referrals: flags.referrals }}
      settings={points.settings}
      summary={points.summary}
      booked={points.booked}
      alert={points.alert}
      referrals={refs.summary}
      review={refs.review}
    />
  );
}
