/**
 * UPLOAD THE SEED TO R2, so Cloudflare can serve it (`cloud/app/src/app.ts`).
 *
 *     npx vite-node scripts/cloud-seed-upload.ts
 *
 * The seed is what `npm run app:bootstrap` writes to `build/app/`: the card
 * database, the generations, the local fields, the audio store and the
 * freshness manifest. The laptop served those files from disk; the cloud serves
 * them from the `hashigo-seed` bucket under the same names, so the app fetches
 * exactly what it always did.
 *
 * ─── THE 300 MB CEILING ─────────────────────────────────────────────────────
 *
 * `wrangler r2 object put` refuses a file over 300 MB, and the audio store is
 * 674 MB. It goes up as R2 MULTIPART through the app Worker (`putLarge`), which
 * R2 joins into one object the Worker can serve natively.
 *
 * ─── THE MANIFEST GOES LAST, ON PURPOSE ─────────────────────────────────────
 *
 * `hashigo-app.json` is what tells a device a newer seed exists. Uploaded first,
 * a device could see the new manifest while the databases are still the old ones
 * — or half-new — and import a mismatched pair. So every database goes up
 * before it, and a failed upload stops the script before the manifest moves.
 *
 * Re-run it after every `app-bootstrap`.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const BUCKET = "hashigo-seed";
const SEED_DIR = resolve("build/app");
/** R2 multipart parts: equal size, ≥ 5 MiB, and under the 100 MB request cap. */
const PART_BYTES = 64 * 1024 * 1024;
const WHOLE_LIMIT = 290 * 1024 * 1024;
const DATABASES = ["hashigo-app.db", "hashigo-app-gen.db", "hashigo-app-fields.db", "hashigo-app-blobs.db"];
const MANIFEST = "hashigo-app.json";

function put(key: string, file: string): void {
  const result = spawnSync(
    "npx",
    ["--yes", "wrangler@4", "r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--remote"],
    { cwd: resolve("cloud/app"), shell: true, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`upload of ${key} failed:\n${(result.stderr || result.stdout).slice(-600)}`);
  }
  console.log(`  uploaded ${key} (${(statSync(file).size / 1024 / 1024).toFixed(1)} MiB)`);
}

/** The app Worker, whose `/admin/multipart/*` routes join a big file inside R2. */
const APP = "https://hashigo.titan-zp4.workers.dev";

if (existsSync(".env")) process.loadEnvFile(".env");
const token = process.env["VITE_MAILBOX_TOKEN"] ?? "";

async function admin(method: string, path: string, body?: BodyInit): Promise<unknown> {
  const response = await fetch(`${APP}/admin/multipart/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body }),
  });
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);
  return response.json();
}

/**
 * A file over wrangler's 300 MB ceiling, sent as R2 multipart through the app
 * Worker. R2 joins the parts into ONE object, which the Worker then serves
 * natively — the earlier design stitched parts inside the Worker and the free
 * plan's CPU budget cut it off at 108 MB of 674.
 */
async function putLarge(key: string, file: string): Promise<void> {
  if (token === "") throw new Error("VITE_MAILBOX_TOKEN must be in .env — the multipart route needs it");
  const size = statSync(file).size;
  const { uploadId } = (await admin("POST", `create?key=${encodeURIComponent(key)}`)) as { uploadId: string };
  const parts: unknown[] = [];
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(PART_BYTES);
    for (let offset = 0, part = 1; offset < size; offset += PART_BYTES, part += 1) {
      const length = readSync(fd, buffer, 0, Math.min(PART_BYTES, size - offset), offset);
      const chunk = new Uint8Array(buffer.subarray(0, length));
      parts.push(
        await admin(
          "PUT",
          `part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&part=${part}`,
          chunk as BodyInit,
        ),
      );
      console.log(`  ${key}: part ${part}, ${Math.round(((offset + length) / size) * 100)}%`);
    }
  } catch (cause) {
    await admin("POST", `abort?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}`).catch(() => undefined);
    throw cause;
  } finally {
    closeSync(fd);
  }
  await admin(
    "POST",
    `complete?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}`,
    JSON.stringify(parts),
  );
  console.log(`  uploaded ${key} (${(size / 1024 / 1024).toFixed(1)} MiB, ${parts.length} parts joined in R2)`);
}

for (const name of [...DATABASES, MANIFEST]) {
  if (!existsSync(join(SEED_DIR, name))) throw new Error(`${name} is not in build/app — run npm run app:bootstrap first`);
}
for (const name of DATABASES) {
  const file = join(SEED_DIR, name);
  if (statSync(file).size <= WHOLE_LIMIT) put(name, file);
  else await putLarge(name, file);
}
// LAST — see the header.
put(MANIFEST, join(SEED_DIR, MANIFEST));
console.log("seed uploaded");
