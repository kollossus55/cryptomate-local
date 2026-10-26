/**
 * Node module loader hooks.
 *
 * Two jobs:
 *  1. Resolve `npm:@base44/sdk@0.8.52` (and any version) to the local shim.
 *     Deno understands `npm:` specifiers; Node does not, so without this every
 *     function fails at import with ERR_UNSUPPORTED_ESM_URL_SCHEME.
 *  2. Resolve bare `@base44/sdk` the same way, since some functions import it
 *     without the npm: prefix.
 */

import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

// fileURLToPath, NOT new URL(...).pathname — on Windows the latter returns
// "/D:/cryptomate-local/server/" with a leading slash, which makes path.join
// produce a path that does not exist, so every function fails to resolve the
// shim and none of them load.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SDK_PATH = path.join(HERE, 'base44-sdk-shim.js');
const RUNTIME_PATH = path.join(HERE, 'base44-runtime-shim.js');

// Fail loudly and once, here, rather than letting all 15 functions fail
// individually with an opaque resolution error further downstream.
for (const p of [SDK_PATH, RUNTIME_PATH]) {
  if (!existsSync(p)) {
    throw new Error(
      `Loader shim missing: ${p}\n` +
      `The server directory looks incomplete — re-extract the download.`
    );
  }
}

const SDK_SHIM = pathToFileURL(SDK_PATH).href;
const RUNTIME_SHIM = pathToFileURL(RUNTIME_PATH).href;

export async function resolve(specifier, context, nextResolve) {
  if (/^(npm:)?@base44\/sdk(@[^/]+)?$/.test(specifier)) {
    return { url: SDK_SHIM, shortCircuit: true };
  }

  // Deno-only scheme for platform services. Only base44:runtime is used.
  if (specifier === 'base44:runtime') {
    return { url: RUNTIME_SHIM, shortCircuit: true };
  }

  // Any other npm: specifier would also fail under Node. Strip the prefix and
  // let normal resolution try node_modules, so a function that imports a real
  // package still works if it is installed.
  if (specifier.startsWith('npm:')) {
    const bare = specifier.slice(4).replace(/@[\d.]+$/, '');
    return nextResolve(bare, context);
  }

  return nextResolve(specifier, context);
}
