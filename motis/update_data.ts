#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2024 Jonah Brüchert <jbb@kaidan.im>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir, readdir, stat, symlink } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { basename, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { URL } from "node:url";
import { spawnSync } from "node:child_process";

const repoDir = "/opt/transitous";

function envBool(name: string, fallback = false): boolean {
  const value = Bun.env[name];
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

async function ensureOutSymlink(outDir: string): Promise<void> {
  const linkPath = `${repoDir}/out`;
  try {
    await stat(linkPath);
    return;
  } catch {
    // continue
  }
  try {
    await symlink(outDir, linkPath);
  } catch (err: any) {
    if (err?.code !== "EEXIST") throw err;
  }
}

async function downloadIfNeeded(url: string, destination: string, force: boolean): Promise<void> {
  if (!force) {
    try {
      await stat(destination);
      console.log(`Using cached file at ${destination}.`);
      return;
    } catch {
      // continue
    }
  }

  console.log(`Downloading ${url} -> ${destination}`);
  await mkdir(dirname(destination), { recursive: true });
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

function runCommand(args: string[], cwd?: string): void {
  console.log(`Running: ${args.join(" ")}`);
  const result = spawnSync(args[0], args.slice(1), {
    stdio: "inherit",
    cwd,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${args.join(" ")}`);
  }
}

function parseRegions(value?: string): string[] {
  if (!value) return [];
  return value.split(/\s+/).filter(Boolean);
}

async function fetchFeeds(regions: string[]): Promise<void> {
  if (regions.length > 0) {
    for (const region of regions) {
      const feed = `${repoDir}/feeds/${region}.json`;
      runCommand(["python3", "./src/fetch.py", feed], repoDir);
    }
    runCommand([
      "python3",
      "./src/generate-motis-config.py",
      "--skip-missing-files",
      ...regions,
    ], repoDir);
    return;
  }

  const entries = await readdir(`${repoDir}/feeds`, { withFileTypes: true });
  const feeds = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => `${repoDir}/feeds/${entry.name}`)
    .sort();
  for (const feed of feeds) {
    runCommand(["python3", "./src/fetch.py", feed], repoDir);
  }
  runCommand(["python3", "./src/generate-motis-config.py", "--skip-missing-files"], repoDir);
}

async function main(): Promise<void> {
  const outDir = Bun.env.OUT_DIR ?? "/var/lib/motis";
  const motisConfig = Bun.env.MOTIS_CONFIG ?? `${outDir}/config.yml`;
  const regions = parseRegions(Bun.env.REGIONS);

  const osmUrl = Bun.env.OSM_URL;
  let osmFile = Bun.env.OSM_FILE;
  const coastlineUrl = Bun.env.COASTLINE_URL;
  let coastlineFile = Bun.env.COASTLINE_FILE;

  const forceOsm = envBool("FORCE_OSM_DOWNLOAD");
  const forceCoastline = envBool("FORCE_COASTLINE_DOWNLOAD");

  await mkdir(outDir, { recursive: true });
  await ensureOutSymlink(outDir);

  if (osmUrl) {
    if (!osmFile) {
      osmFile = `${outDir}/${basename(new URL(osmUrl).pathname)}`;
    }
    await downloadIfNeeded(osmUrl, osmFile, forceOsm);
  }

  if (coastlineUrl) {
    if (!coastlineFile) {
      coastlineFile = `${outDir}/${basename(new URL(coastlineUrl).pathname)}`;
    }
    await downloadIfNeeded(coastlineUrl, coastlineFile, forceCoastline);
  }

  await fetchFeeds(regions);

  try {
    await stat(motisConfig);
  } catch {
    throw new Error(`Generated config not found at ${motisConfig}.`);
  }

  runCommand(["/opt/motis/motis", "import", "-c", motisConfig]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
