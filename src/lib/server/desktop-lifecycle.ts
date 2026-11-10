import process from "node:process";

const lifecycle = globalThis as typeof globalThis & {
  clipforgeDesktopShutdown?: { stop: () => void };
};

/** Imported only by Node instrumentation; the desktop supervisor owns this IPC channel. */
export function attachDesktopShutdown(stop: () => void): void {
  if (!process.send) return;
  if (lifecycle.clipforgeDesktopShutdown) {
    lifecycle.clipforgeDesktopShutdown.stop = stop;
    return;
  }
  lifecycle.clipforgeDesktopShutdown = { stop };
  process.on("message", (message: unknown) => {
    if (!message || typeof message !== "object" || !("type" in message) || message.type !== "clipforge:shutdown") return;
    lifecycle.clipforgeDesktopShutdown?.stop();
  });
}
