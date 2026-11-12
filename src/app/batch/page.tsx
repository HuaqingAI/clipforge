import { redirect } from "next/navigation";

/** Keep saved links usable after retiring the sales-only workflow. */
export default function BatchPage() {
  redirect("/project/new");
}
