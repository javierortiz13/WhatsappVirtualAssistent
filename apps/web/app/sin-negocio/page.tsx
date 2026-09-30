import { redirect } from "next/navigation";

/** Ruta del día 6: el registro de negocios vive en /registro. */
export default function SinNegocio() {
  redirect("/registro");
}
