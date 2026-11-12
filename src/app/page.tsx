import { redirect } from "next/navigation";

// Home page redirects directly to the new "create-first" landing page at /start.
// The shared desktop/Web start page contains TIDEWE creation and recent projects.
export default function HomePage() {
  redirect("/start");
}
