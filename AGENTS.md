<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Kling workflow scope

Kling supports single-shot generation and batch motion generation, followed by the standard composition workflow. The separate Kling one-click film feature has been removed: do not restore its film runner, film API routes, planning/composition adapters, or UI while changing pacing or video generation. Historical database migrations and the minimal legacy-job submission guard are compatibility records, not an active film workflow.
