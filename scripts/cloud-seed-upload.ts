import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const BUCKET = "hashigo-seed";
const SEED_DIR = resolve("build/app");
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
put(MANIFEST, join(SEED_DIR, MANIFEST));
console.log("seed uploaded");
