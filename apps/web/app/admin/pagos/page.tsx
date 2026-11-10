import { Decimal } from "@caja/core";
import { getAdmin, getNow, getPayments } from "../data";
import { usd } from "../format";
import { errorText, OK, type SectionParams } from "../messages";
import { PagosView } from "../views/pagos";

/** /admin/pagos: por verificar y aprobados este mes. */
export default async function AdminPagos({
  searchParams,
}: {
  searchParams: Promise<SectionParams>;
}) {
  await getAdmin();
  const sp = await searchParams;
  const { pending, approvedMonth } = await getPayments();
  const total = approvedMonth
    .filter((p) => p.status === "approved")
    .reduce((acc, p) => acc.plus(p.amountUsd), new Decimal(0));
  return (
    <PagosView
      banner={{ ok: sp.ok ? (OK[sp.ok] ?? null) : null, error: errorText(sp.error) }}
      pending={pending}
      approvedMonth={approvedMonth}
      approvedTotalUsd={usd(total)}
      now={getNow()}
    />
  );
}
