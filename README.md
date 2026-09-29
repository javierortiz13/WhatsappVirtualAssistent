# Asistente de Caja

Libro de caja por WhatsApp para pymes venezolanas. El dueño registra gastos y ventas como le escribiría a su cajera (texto, nota de voz o foto de factura); el sistema guarda todo con la tasa BCV del día y devuelve el cierre diario. El dashboard sirve para ver, corregir y exportar.

El diseño completo, con sus ocho fases y decisiones, está en [`docs/DISENO-MVP.md`](docs/DISENO-MVP.md).

## Estructura

```
apps/web        Next.js: dashboard, API interna, webhook de Meta
apps/worker     Node: cola pg-boss, agente, cron de tasa BCV
packages/core   Dominio puro: dinero, fechas, ledger, agente, render, whatsapp, media
packages/db     Esquema Drizzle, migraciones SQL, cliente, seed
packages/config tsconfig base
evals/          Casos de evaluación del agente
docs/           Diseño, runbooks
```

## Requisitos

- Node 22.12 o superior, pnpm 10.
- Postgres 16 o superior (Supabase Pro en producción). Los tests de base de datos corren sobre PGlite y no necesitan servidor.

## Comandos

```bash
pnpm install
cp .env.example .env        # y completar
pnpm lint                   # biome
pnpm typecheck
pnpm test
pnpm db:migrate             # aplica packages/db/migrations en orden
pnpm db:seed                # tenants del piloto
```

## Convenciones

- TypeScript estricto, ESM. Zod en toda frontera.
- Dinero: `Decimal` (decimal.js) en dominio; `string` hacia la base; nunca `number`.
- Fechas de negocio como `YYYY-MM-DD` en hora de Caracas; instantes en UTC.
- `packages/core` no importa de `apps/`, de Next ni de pg-boss.
- Todo texto visible al usuario vive en `packages/core/src/render/es-VE.ts`.
- Migraciones SQL escritas a mano y revisadas; nunca se edita una migración aplicada.
- Commits con Conventional Commits.
