#!/usr/bin/env node
import fs from "fs";
import os from "os";
import path from "path";
import process from "process";
import { spawnSync } from "child_process";

const USAGE = `
Usage:
  node scripts/skills-sync.mjs [options]

Options:
  --config <path>     Config file path (default: skills.config.json)
  --sync              Sync skills from source repos
  --clean             Remove all synced skills
  --allow-dirty       Allow running with a dirty worktree
  --dry-run           Print commands without executing
  -h, --help          Show help
`;

function die(message) {
  console.error(message);
  process.exit(1);
}

function run(cmd, options = {}) {
  if (options.dryRun) {
    console.log(`[dry-run] ${cmd}`);
    return "";
  }
  const result = spawnSync(cmd, {
    shell: true,
    stdio: ["ignore", "pipe", "inherit"],
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

function git(cmd, options = {}) {
  return run(`git ${cmd}`, options);
}

function parseArgs(argv) {
  const options = {
    config: "skills.config.json",
    sync: false,
    clean: false,
    allowDirty: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") {
      options.config = argv[++i];
    } else if (arg === "--sync") {
      options.sync = true;
    } else if (arg === "--clean") {
      options.clean = true;
    } else if (arg === "--allow-dirty") {
      options.allowDirty = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(USAGE.trim());
      process.exit(0);
    } else {
      die(`Unknown arg: ${arg}\n\n${USAGE.trim()}`);
    }
  }
  if (!options.sync && !options.clean) {
    options.sync = true;
  }
  return options;
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    die(`Config not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, "utf8");
  const config = JSON.parse(raw);
  if (!config.targets || !Array.isArray(config.targets)) {
    die("Config requires a 'targets' array.");
  }
  config.skillsPath = config.skillsPath || "skills";
  config.skillsDir = config.skillsDir || "skills";
  config.protected = Array.isArray(config.protected) ? config.protected : [];
  return config;
}

function ensureClean(options) {
  const status = git("status --porcelain", options);
  if (status && !options.allowDirty) {
    die("Worktree is dirty. Commit/stash or use --allow-dirty.");
  }
}

function ensureDir(p, options) {
  if (options.dryRun) return;
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

function copyDir(src, dst, options) {
  if (options.dryRun) {
    console.log(`[dry-run] copy ${src} -> ${dst}`);
    return;
  }
  if (!fs.existsSync(src)) {
    console.warn(`Missing source dir: ${src}`);
    return false;
  }
  fs.rmSync(dst, { recursive: true, force: true });
  ensureDir(path.dirname(dst), options);
  fs.cpSync(src, dst, { recursive: true });
  return true;
}

function removeDir(dst, options) {
  if (options.dryRun) {
    console.log(`[dry-run] rm -rf ${dst}`);
    return;
  }
  fs.rmSync(dst, { recursive: true, force: true });
}

function cloneRepo(repo, options) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));
  const cmd = `git clone --depth 1 ${repo} ${tempDir}`;
  run(cmd, options);
  return tempDir;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = run("git rev-parse --show-toplevel", options);
  process.chdir(root);

  ensureClean(options);

  const configPath = path.resolve(root, options.config);
  const config = loadConfig(configPath);
  const skillsPath = path.resolve(root, config.skillsPath);

  if (options.clean) {
    for (const target of config.targets) {
      for (const outputName of Object.values(target.skills || {})) {
        if (config.protected.includes(outputName)) continue;
        const dst = path.join(skillsPath, outputName);
        removeDir(dst, options);
      }
    }
    return;
  }

  if (!options.sync) return;

  for (const target of config.targets) {
    const repo = target.repo;
    if (!repo) die(`Target missing repo: ${target.name || "unknown"}`);

    const tempDir = cloneRepo(repo, options);
    try {
      const skillsDir = target.skillsDir || config.skillsDir;
      for (const [sourceName, outputName] of Object.entries(
        target.skills || {}
      )) {
        const src = path.join(tempDir, skillsDir, sourceName);
        const dst = path.join(skillsPath, outputName);
        const copied = copyDir(src, dst, options);
        if (!copied) {
          console.warn(
            `Skip ${outputName}: ${repo} does not have ${skillsDir}/${sourceName}`
          );
        }
      }
    } finally {
      if (!options.dryRun) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }
}

main();
