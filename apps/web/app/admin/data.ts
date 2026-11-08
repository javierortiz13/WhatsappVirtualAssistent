import "server-only";
import { cache } from "react";
import { loadFunnel, loadPayments, loadTenants, requireAdmin } from "@/lib/admin";

/**
 * Lecturas de /admin compartidas por el layout (los conteos del menú) y cada sección, una sola vez
 * por petición (rediseño 08/11). Son los mismos loaders de `lib/admin.ts`.
 */
/** Cada página lo pide también (no basta con el layout): una sola vez por petición. */
export const getAdmin = cache(requireAdmin);
export const getNow = cache(() => new Date());
export const getTenants = cache(async () => loadTenants(getNow()));
export const getPayments = cache(async () => loadPayments(getNow()));
export const getFunnel = cache(async () => loadFunnel(await getTenants(), getNow()));
