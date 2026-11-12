import { redirect } from "next/navigation";

/** Keep saved links usable after retiring the sales-only workflow. */
export default function TopicProjectPage() {
  redirect("/project/new");
}
