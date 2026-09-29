import { redirect } from "next/navigation";
import { currentSession } from "@/lib/session";

export default async function Home() {
  const session = await currentSession();
  redirect(session ? "/inicio" : "/login");
}
