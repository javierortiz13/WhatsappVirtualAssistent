import { getAdmin, getTenants } from "../data";
import { filterClients, parseFilters, stateCounts } from "../derive";
import { errorText, OK } from "../messages";
import { ClientesView } from "../views/clientes";

/** /admin/clientes: la lista de negocios, filtrada en el servidor con los filtros de la URL. */
export default async function AdminClientes({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await getAdmin();
  const sp = await searchParams;
  const tenants = await getTenants();
  const filters = parseFilters(sp);
  const ok = typeof sp.ok === "string" ? sp.ok : undefined;
  const error = typeof sp.error === "string" ? sp.error : undefined;
  return (
    <ClientesView
      banner={{ ok: ok ? (OK[ok] ?? null) : null, error: errorText(error) }}
      list={filterClients(tenants, filters)}
      total={tenants.filter((t) => filters.internas || !t.internal).length}
      filters={filters}
      counts={stateCounts(tenants, filters)}
    />
  );
}
