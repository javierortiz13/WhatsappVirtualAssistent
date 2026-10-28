"use server";

import { cookies } from "next/headers";
import { PRIVACY_BANNER_COOKIE } from "@/lib/privacy-banner";

export async function dismissPrivacyBanner(): Promise<void> {
  (await cookies()).set(PRIVACY_BANNER_COOKIE, "1", {
    maxAge: 365 * 86_400,
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  });
}
