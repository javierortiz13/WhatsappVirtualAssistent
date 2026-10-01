import { describe, expect, it } from "vitest";
import { MemoryObjectStore, StorageError, SupabaseStorage } from "../src/storage/store";

function fake(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("SupabaseStorage", () => {
  const opts = { url: "https://x.supabase.co/", serviceKey: "SR", bucket: "receipts" };

  it("sube con la clave service_role y el tipo, borra, y firma URLs de corta vida", async () => {
    const f = fake((url) =>
      url.includes("/object/sign/")
        ? Response.json({ signedURL: "/object/sign/receipts/t/a.jpg?token=abc" })
        : Response.json({ Key: "receipts/t/a.jpg" }),
    );
    const s = new SupabaseStorage({ ...opts, fetchImpl: f.fetchImpl });
    await s.put("t/a.jpg", new Uint8Array([1]), "image/jpeg");
    await s.delete("t/a.jpg");
    const url = await s.signedUrl("t/a.jpg", 600);
    expect(f.calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      "POST https://x.supabase.co/storage/v1/object/receipts/t/a.jpg",
      "DELETE https://x.supabase.co/storage/v1/object/receipts/t/a.jpg",
      "POST https://x.supabase.co/storage/v1/object/sign/receipts/t/a.jpg",
    ]);
    const h = f.calls[0]?.init?.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer SR");
    expect(h["Content-Type"]).toBe("image/jpeg");
    expect(h["x-upsert"]).toBe("false");
    expect(JSON.parse(String(f.calls[2]?.init?.body))).toEqual({ expiresIn: 600 });
    expect(url).toBe("https://x.supabase.co/storage/v1/object/sign/receipts/t/a.jpg?token=abc");
  });

  it("errores HTTP lanzan StorageError con el estado", async () => {
    const s = new SupabaseStorage({
      ...opts,
      fetchImpl: fake(() => new Response("nope", { status: 403 })).fetchImpl,
    });
    await expect(s.put("k", new Uint8Array(1), "image/png")).rejects.toMatchObject({
      name: "StorageError",
      status: 403,
    });
    await expect(s.signedUrl("k", 10)).rejects.toBeInstanceOf(StorageError);
  });

  it("MemoryObjectStore guarda y borra", async () => {
    const m = new MemoryObjectStore();
    await m.put("a", new Uint8Array([1]), "image/png");
    expect(m.objects.size).toBe(1);
    await m.delete("a");
    expect(m.objects.size).toBe(0);
  });
});
