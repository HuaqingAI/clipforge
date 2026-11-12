import { redirect } from "next/navigation";

/** Keep saved links usable after retiring the sales-only workflow. */
export default function ClonePage() {
  redirect("/project/new");
}
