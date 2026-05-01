import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serviceVersion = process.env.FASTAPI_SERVICE_VERSION ?? "0.1.0";
const targetPlatform = process.env.TARGET_PLATFORM ?? process.platform;

const targets = {
  win32: {
    archiveType: "zip",
    python: process.env.PYTHON ?? "python",
  },
};

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

function runJson(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }

  return JSON.parse(result.stdout);
}

function assertSupportedPython(command) {
  const version = runJson(command, [
    "-c",
    "import json, sys; print(json.dumps({'major': sys.version_info.major, 'minor': sys.version_info.minor, 'executable': sys.executable}))",
  ]);

  if (version.major !== 3 || version.minor !== 11) {
    throw new Error(
      `lasso-fastapi packages the donor dependency set with Python 3.11; found ${version.major}.${version.minor} at ${version.executable}. Set PYTHON to a Python 3.11 executable.`,
    );
  }
}

function versionedAssetName(version, platform, archiveType) {
  return `lasso-fastapi-${version}-${platform}.${archiveType === "zip" ? "zip" : "tar.gz"}`;
}

async function compressPackage(packageRoot, outputPath, archiveType) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });

  if (archiveType === "zip") {
    run("powershell", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path ${JSON.stringify(path.join(packageRoot, "*"))} -DestinationPath ${JSON.stringify(outputPath)} -Force`,
    ]);
    return outputPath;
  }

  run("tar", ["-czf", outputPath, "-C", packageRoot, "."]);
  return outputPath;
}

export async function packageFastapi(platform = targetPlatform, version = serviceVersion) {
  const target = targets[platform];
  if (!target) {
    throw new Error(`Unsupported target platform: ${platform}. Supported platforms: ${Object.keys(targets).join(", ")}.`);
  }

  const outputRoot = path.join(repoRoot, "output", "package", version, platform);
  const packageRoot = path.join(outputRoot, "payload");
  const packagesRoot = path.join(packageRoot, "python-packages");
  const appRoot = path.join(packageRoot, "app");
  const outputPath = path.join(repoRoot, "dist", versionedAssetName(version, platform, target.archiveType));

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(packageRoot, { recursive: true });
  await cp(path.join(repoRoot, "app"), appRoot, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}__pycache__${path.sep}`),
  });

  assertSupportedPython(target.python);
  run(target.python, ["-m", "pip", "install", "--target", packagesRoot, "-r", path.join(appRoot, "requirements.txt")]);

  await writeFile(path.join(packageRoot, "lasso-fastapi.py"), launcherSource, "utf8");
  await writeFile(
    path.join(packageRoot, "SERVICE-LASSO-PACKAGE.json"),
    `${JSON.stringify(
      {
        serviceId: "fastapi",
        upstream: {
          source: "TypeRefinery donor service",
          donorPath: "services/fastapi",
          version,
        },
        packagedBy: "service-lasso/lasso-fastapi",
        platform,
        arch: "x64",
        command: "python ./lasso-fastapi.py",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  if (platform !== "win32") {
    await chmod(path.join(packageRoot, "lasso-fastapi.py"), 0o755);
  }

  await compressPackage(packageRoot, outputPath, target.archiveType);
  console.log(`[lasso-fastapi] packaged ${outputPath}`);
  return outputPath;
}

const launcherSource = String.raw`import os
import sys
from pathlib import Path

package_root = Path(__file__).resolve().parent
app_root = package_root / "app"
packages_root = package_root / "python-packages"

sys.path.insert(0, str(packages_root))
sys.path.insert(0, str(app_root))

existing_pythonpath = os.environ.get("PYTHONPATH", "")
os.environ["PYTHONPATH"] = os.pathsep.join([str(packages_root), str(app_root), existing_pythonpath])
os.environ.setdefault("SERVICE_DATA_PATH", str(Path(os.environ.get("SERVICE_ROOT", os.getcwd())) / "runtime" / "data"))
os.environ.setdefault("SERVICE_LOG_PATH", str(Path(os.environ.get("SERVICE_ROOT", os.getcwd())) / "runtime" / "logs"))

Path(os.environ["SERVICE_DATA_PATH"]).mkdir(parents=True, exist_ok=True)
Path(os.environ["SERVICE_LOG_PATH"]).mkdir(parents=True, exist_ok=True)

from uvicorn import run

host = os.environ.get("API_HOST", "127.0.0.1")
port = int(os.environ.get("SERVICE_PORT") or os.environ.get("API_PORT") or "8000")
run("main:app", host=host, port=port, app_dir=str(app_root), log_level=os.environ.get("UVICORN_LOG_LEVEL", "info"))
`;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await packageFastapi();
}
