import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

/**
 * Return the path to a file in a manifest in a platform independent way.
 * Next writes manifest entries with `/` even on Windows.  `path.join` is
 * deliberately used here instead of a glob so route segments such as
 * `[id]` remain literal directory names.
 */
function manifestPath(root, value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const normalized = value.replaceAll("\\", "/");
  if (isAbsolute(normalized)) return resolve(normalized);
  return resolve(root, ...normalized.split("/"));
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function readJson(file) {
  if (!isFile(file)) return { exists: false, value: null };
  try {
    return { exists: true, value: JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return { exists: true, value: null };
  }
}

function normalizeRelative(file, root) {
  return relative(root, file).replaceAll(sep, "/").replaceAll("\\", "/");
}

/**
 * Validate the production output used by the source checkout launcher.
 *
 * `buildDirectory` is intentionally an argument rather than a hard-coded
 * `.next`. Both relative names and absolute paths are accepted; route names
 * are always handled as literal
 * path segments (including `[id]` on Windows).
 *
 * The returned `missing` entries are slash-separated paths relative to the
 * build directory.  A missing/invalid root BUILD_ID is reported as
 * `BUILD_ID`, and `buildId` is the trimmed root value when it is available.
 */
export function localBuildStatus(root, buildDirectory = ".next") {
  const projectRoot = resolve(String(root));
  const distDir = isAbsolute(String(buildDirectory))
    ? resolve(String(buildDirectory))
    : resolve(projectRoot, String(buildDirectory));
  const standaloneDir = join(distDir, "standalone");
  const standaloneDistDir = join(standaloneDir, ".next");
  const missing = new Set();
  const addMissing = (file) => missing.add(normalizeRelative(file, distDir));
  const requireFile = (file) => {
    if (!isFile(file)) addMissing(file);
    return isFile(file);
  };

  const buildIdPath = join(distDir, "BUILD_ID");
  let buildId = null;
  if (isFile(buildIdPath)) {
    try {
      const value = readFileSync(buildIdPath, "utf8").trim();
      if (value) buildId = value;
      else addMissing(buildIdPath);
    } catch {
      addMissing(buildIdPath);
    }
  } else {
    addMissing(buildIdPath);
  }

  // These are the small set of files that the production server always
  // needs.  Other Next internals are checked through required-server-files
  // below, avoiding a brittle inventory of node_modules or version-specific
  // optional manifests.
  const rootManifestPaths = [
    "server/app-paths-manifest.json",
    "server/pages-manifest.json",
    "required-server-files.json",
    "routes-manifest.json",
    "build-manifest.json",
    "prerender-manifest.json",
    "server/middleware-manifest.json",
    "server/server-reference-manifest.json",
    "standalone/server.js",
  ];
  for (const path of rootManifestPaths) requireFile(join(distDir, ...path.split("/")));

  // The standalone server starts with cwd at `.next/standalone` and reads
  // all of its Next output from `.next/` below that directory.  BUILD_ID was
  // not copied by every Next release, so compare it when present but do not
  // reject a build solely because the optional copy is absent.
  for (const standaloneBuildId of [join(standaloneDistDir, "BUILD_ID"), join(standaloneDir, "BUILD_ID")]) {
    if (!isFile(standaloneBuildId)) continue;
    try {
      if (!buildId || readFileSync(standaloneBuildId, "utf8").trim() !== buildId) addMissing(standaloneBuildId);
    } catch {
      addMissing(standaloneBuildId);
    }
  }

  const appManifestFile = join(distDir, "server", "app-paths-manifest.json");
  const pagesManifestFile = join(distDir, "server", "pages-manifest.json");
  const appManifestResult = readJson(appManifestFile);
  const pagesManifestResult = readJson(pagesManifestFile);
  const appManifest = appManifestResult.value;
  const pagesManifest = pagesManifestResult.value;

  // A malformed manifest is just as unusable as a missing one.  Keep the
  // missing path stable so callers can show a useful repair message.
  if (appManifestResult.exists && (!appManifest || Array.isArray(appManifest) || typeof appManifest !== "object")) addMissing(appManifestFile);
  if (pagesManifestResult.exists && (!pagesManifest || Array.isArray(pagesManifest) || typeof pagesManifest !== "object")) addMissing(pagesManifestFile);

  const standaloneAppServer = join(standaloneDistDir, "server");
  const standalonePagesServer = join(standaloneDistDir, "server");
  if (appManifest && typeof appManifest === "object" && !Array.isArray(appManifest)) {
    for (const [route, entry] of Object.entries(appManifest)) {
      const rootEntry = manifestPath(join(distDir, "server"), entry);
      if (!rootEntry) {
        addMissing(join(distDir, "server", String(entry || "<invalid-app-entry>")));
        continue;
      }
      requireFile(rootEntry);
      const entryRelative = relative(join(distDir, "server"), rootEntry);
      const standaloneEntry = join(standaloneAppServer, ...entryRelative.split(/[\\/]+/));
      requireFile(standaloneEntry);

      // Next emits route-specific client manifests only for routes that need
      // one.  For static routes, mirror the root's presence. Dynamic app
      // pages must always have one: without it Next fails at request time with
      // "The client reference manifest ... does not exist".
      const entryName = entryRelative.replace(/\.(?:c?m?js)$/i, "");
      const clientManifest = `${entryName}_client-reference-manifest.js`;
      const rootClientManifest = join(join(distDir, "server"), ...clientManifest.split(/[\\/]+/));
      const dynamicRoute = String(route).includes("[") || entryRelative.includes("[");
      if (dynamicRoute || isFile(rootClientManifest)) {
        requireFile(rootClientManifest);
        const standaloneClientManifest = join(standaloneAppServer, ...clientManifest.split(/[\\/]+/));
        requireFile(standaloneClientManifest);
      }
    }
  }

  if (pagesManifest && typeof pagesManifest === "object" && !Array.isArray(pagesManifest)) {
    for (const entry of Object.values(pagesManifest)) {
      const rootEntry = manifestPath(join(distDir, "server"), entry);
      if (!rootEntry) {
        addMissing(join(distDir, "server", String(entry || "<invalid-page-entry>")));
        continue;
      }
      requireFile(rootEntry);
      const entryRelative = relative(join(distDir, "server"), rootEntry);
      requireFile(join(standalonePagesServer, ...entryRelative.split(/[\\/]+/)));
    }
  }

  // Next writes a list of files that are required by its production server.
  // It is the most stable way to catch e.g. a missing 500.html or middleware
  // manifest across webpack/Turbopack releases.  The manifest itself is also
  // copied into standalone by Next.
  const requiredResult = readJson(join(distDir, "required-server-files.json"));
  const requiredFiles = requiredResult.value?.files;
  if (Array.isArray(requiredFiles)) {
    const rootName = relative(projectRoot, distDir).replaceAll("\\", "/").replace(/\/$/, "");
    for (const listed of requiredFiles) {
      if (typeof listed !== "string" || listed.length === 0) continue;
      const listedPath = listed.replaceAll("\\", "/");
      const rootRelative = rootName && (listedPath === rootName || listedPath.startsWith(`${rootName}/`))
        ? listedPath.slice(rootName.length + 1)
        : listedPath;
      const rootFile = manifestPath(distDir, rootRelative);
      if (!rootFile) continue;
      requireFile(rootFile);
      const standaloneFile = join(standaloneDistDir, ...rootRelative.split("/"));
      requireFile(standaloneFile);
    }
  }

  return { ok: missing.size === 0, buildId, missing: [...missing].sort() };
}

export default localBuildStatus;
