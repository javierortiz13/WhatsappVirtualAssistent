import { enqueueProcessMessage } from "@caja/db/queue";
import { noteInvalidSignature } from "@/lib/alerts";
import { boss } from "@/lib/boss";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { handleInbound, handleVerify } from "@/lib/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = {
  debug: () => {},
  info: (o: Record<string, unknown>, m?: string) =>
    console.info(JSON.stringify({ level: "info", msg: m, ...o })),
  warn: (o: Record<string, unknown>, m?: string) =>
    console.warn(JSON.stringify({ level: "warn", msg: m, ...o })),
  error: (o: Record<string, unknown>, m?: string) =>
    console.error(JSON.stringify({ level: "error", msg: m, ...o })),
};

export async function GET(req: Request) {
  return handleVerify(req, { verifyToken: env().META_VERIFY_TOKEN });
}

export async function POST(req: Request) {
  return handleInbound(req, {
    appSecret: env().META_APP_SECRET,
    verifyToken: env().META_VERIFY_TOKEN,
    log,
    onInvalidSignature: () => noteInvalidSignature(),
    ingest: async () => {
      const b = await boss();
      return {
        db: db(),
        enqueue: (tx, job, key) => enqueueProcessMessage(b, tx, job, key),
        log,
      };
    },
  });
}
