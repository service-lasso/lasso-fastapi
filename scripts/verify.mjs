import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageFastapi } from "./package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.TARGET_PLATFORM ?? process.platform;
const serviceVersion = process.env.FASTAPI_SERVICE_VERSION ?? "0.1.0";
const python = process.env.PYTHON ?? "python";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve loopback port.")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(port, timeoutMs = 90_000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthcheck`);
      if (response.status === 200) {
        return;
      }
      lastError = new Error(`Unexpected health status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }

  throw lastError ?? new Error(`Timed out waiting for FastAPI on ${port}.`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    sleep(10_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

const artifact = await packageFastapi(platform, serviceVersion);
const verifyRoot = path.join(repoRoot, "output", "verify", serviceVersion, platform);
const serviceRoot = path.join(verifyRoot, "service");
const extractRoot = path.join(serviceRoot, ".state", "extracted", "current");
const serviceManifest = JSON.parse(await readFile(path.join(repoRoot, "service.json"), "utf8"));
const metadataPath = path.join(extractRoot, "SERVICE-LASSO-PACKAGE.json");
const port = await reserveLoopbackPort();

if (serviceManifest.id !== "fastapi" || serviceManifest.version !== serviceVersion) {
  throw new Error(`Unexpected service manifest identity: ${JSON.stringify({ id: serviceManifest.id, version: serviceManifest.version })}`);
}

const [healthcheck] = serviceManifest.healthchecks ?? [];
if (
  serviceManifest.healthcheck !== undefined ||
  serviceManifest.healthchecks?.length !== 1 ||
  healthcheck?.id !== "http-healthcheck" ||
  healthcheck?.type !== "http" ||
  healthcheck?.url !== "http://${API_HOST}:${API_PORT}/healthcheck" ||
  serviceManifest.ports?.service !== 8000
) {
  throw new Error(`FastAPI service.json health/ports drifted: ${JSON.stringify(serviceManifest)}`);
}

await rm(verifyRoot, { recursive: true, force: true });
await mkdir(extractRoot, { recursive: true });
run("tar", ["-xf", artifact, "-C", extractRoot]);

const packageMetadata = JSON.parse(await readFile(metadataPath, "utf8"));
if (
  packageMetadata.serviceId !== "fastapi" ||
  packageMetadata.upstream?.version !== serviceVersion ||
  packageMetadata.packagedBy !== "service-lasso/lasso-fastapi" ||
  packageMetadata.platform !== platform
) {
  throw new Error(`Unexpected package metadata: ${JSON.stringify(packageMetadata)}`);
}

const child = spawn(python, ["./lasso-fastapi.py"], {
  cwd: extractRoot,
  env: {
    ...process.env,
    SERVICE_ROOT: serviceRoot,
    SERVICE_PORT: String(port),
    API_HOST: "127.0.0.1",
    API_PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout?.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForHealth(port);
  console.log("[lasso-fastapi] verification passed");
} catch (error) {
  console.error("[lasso-fastapi] stdout:");
  console.error(stdout);
  console.error("[lasso-fastapi] stderr:");
  console.error(stderr);
  throw error;
} finally {
  await stopChild(child);
}
