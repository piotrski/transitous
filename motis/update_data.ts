#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2024 Jonah Brüchert <jbb@kaidan.im>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { lstat, mkdir, readdir, readlink, stat, symlink, unlink, utimes } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { basename, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { URL } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const repoDir = "/opt/transitous";

function envBool(name: string, fallback = false): boolean {
  const value = Bun.env[name];
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

async function ensureOutSymlink(outDir: string): Promise<void> {
  const linkPath = `${repoDir}/out`;
  try {
    const stats = await lstat(linkPath);
    if (stats.isSymbolicLink()) {
      const target = await readlink(linkPath);
      if (target === outDir) {
        return; // Already correct symlink
      }
      // Wrong target, remove and recreate
      await unlink(linkPath);
    } else {
      // Exists but not a symlink (e.g., directory), skip to avoid data loss
      console.warn(`Warning: ${linkPath} exists but is not a symlink, skipping`);
      return;
    }
  } catch {
    // Path doesn't exist, continue to create symlink
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
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${args.join(" ")}`);
  }
}

function runCommandAsync(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`Running: ${args.join(" ")}`);
    const child = spawn(args[0], args.slice(1), {
      stdio: "inherit",
      cwd,
      env: process.env,
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed: ${args.join(" ")}`));
      } else {
        resolve();
      }
    });
    child.on("error", reject);
  });
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const results: Promise<void>[] = [];
  const executing: Promise<void>[] = [];

  for (const item of items) {
    const p = fn(item).then(() => {
      executing.splice(executing.indexOf(p), 1);
    });
    results.push(p);
    executing.push(p);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.allSettled(results);
}

function parseRegions(value?: string): string[] {
  if (!value) return [];
  return value.split(/\s+/).filter(Boolean);
}

interface FeedSource {
  name: string;
  region: string;
  spec: string;
  download_name: string;
  download_path: string;
  output_path: string;
  url: string;
  url_override?: string;
  cache_url?: string;
  headers: Record<string, string>;
  ignore_tls_errors: boolean;
  fetch_interval_days?: number;
  method?: string;
  request_body?: string;
}

function runCommandCapture(args: string[], cwd?: string): string {
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    env: process.env,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${args.join(" ")}\n${result.stderr}`);
  }
  return result.stdout;
}

async function downloadFeed(source: FeedSource): Promise<boolean> {
  const destPath = source.download_path;

  // Check if we should skip based on fetch interval
  if (source.fetch_interval_days) {
    try {
      const stats = await stat(destPath);
      const daysSinceModified = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
      if (daysSinceModified < source.fetch_interval_days) {
        return false; // Skip, not yet time to refetch
      }
    } catch {
      // File doesn't exist, continue to download
    }
  }

  // Try URLs in order: url_override, url, cache_url
  const urlsToTry: string[] = [];
  if (source.url_override) urlsToTry.push(source.url_override);
  if (source.url) urlsToTry.push(source.url);
  if (source.cache_url) urlsToTry.push(source.cache_url);

  if (urlsToTry.length === 0) {
    console.error(`No URL for ${source.region}-${source.name}`);
    return false;
  }

  // Check local file modification time for If-Modified-Since
  let lastModified: Date | null = null;
  try {
    const stats = await stat(destPath);
    lastModified = new Date(stats.mtimeMs);
  } catch {
    // File doesn't exist
  }

  const headers: Record<string, string> = {
    "User-Agent": "Transitous GTFS Fetcher (https://transitous.org)",
    ...source.headers,
  };

  if (lastModified) {
    headers["If-Modified-Since"] = lastModified.toUTCString();
  }

  await mkdir(dirname(destPath), { recursive: true });

  for (const url of urlsToTry) {
    try {
      const fetchOptions: RequestInit = {
        method: source.method || "GET",
        headers,
      };
      if (source.request_body) {
        fetchOptions.body = source.request_body;
      }

      const response = await fetch(url, fetchOptions);

      if (response.status === 304) {
        return false; // Not modified
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Verify it's a valid ZIP by checking magic bytes
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
        throw new Error("Response is not a valid ZIP file");
      }

      // Write to file
      await Bun.write(destPath, buffer);

      // Update mtime if server provided Last-Modified
      const serverLastModified = response.headers.get("Last-Modified");
      if (serverLastModified) {
        const mtime = new Date(serverLastModified).getTime() / 1000;
        await utimes(destPath, mtime, mtime);
      }

      return true; // Downloaded successfully
    } catch (err) {
      if (url === urlsToTry[urlsToTry.length - 1]) {
        throw err; // Last URL failed, propagate error
      }
      // Try next URL
    }
  }

  return false;
}

async function fetchFeeds(
  regions: string[],
  concurrency: number,
  osmFile?: string,
  coastlineFile?: string
): Promise<void> {
  // Get list of feed files to process
  let feedFiles: string[];
  if (regions.length > 0) {
    feedFiles = regions.map((r) => `${repoDir}/feeds/${r}.json`);
  } else {
    const entries = await readdir(`${repoDir}/feeds`, { withFileTypes: true });
    feedFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => `${repoDir}/feeds/${entry.name}`)
      .sort();
  }

  // Resolve all sources from all feed files
  console.log(`Resolving sources from ${feedFiles.length} feed files...`);
  const allSources: FeedSource[] = [];
  for (const feedFile of feedFiles) {
    try {
      const output = runCommandCapture(
        ["python3", "./src/fetch.py", "--resolve-sources", feedFile],
        repoDir
      );
      const sources: FeedSource[] = JSON.parse(output);
      allSources.push(...sources);
    } catch (err) {
      console.error(`Failed to resolve sources from ${feedFile}: ${err}`);
    }
  }

  console.log(`Downloading ${allSources.length} feeds with concurrency ${concurrency}...`);

  // Download all feeds in parallel
  let downloaded = 0;
  let skipped = 0;
  let errors = 0;

  await runWithConcurrency(allSources, concurrency, async (source) => {
    try {
      const wasDownloaded = await downloadFeed(source);
      if (wasDownloaded) {
        downloaded++;
        console.log(`Downloaded: ${source.region}-${source.name}`);
      } else {
        skipped++;
      }
    } catch (err) {
      errors++;
      console.error(`Failed to download ${source.region}-${source.name}: ${err}`);
    }
  });

  console.log(`Downloads complete: ${downloaded} downloaded, ${skipped} skipped, ${errors} errors`);

  // Run postprocessing for each feed file
  console.log("Running postprocessing...");
  for (const feedFile of feedFiles) {
    try {
      runCommand(["python3", "./src/fetch.py", "--postprocess-only", feedFile], repoDir);
    } catch (err) {
      console.error(`Postprocessing failed for ${feedFile}: ${err}`);
    }
  }

  // Generate MOTIS config
  const configArgs = [
    "python3",
    "./src/generate-motis-config.py",
    "--skip-missing-files",
  ];
  if (osmFile) {
    configArgs.push("--osm", basename(osmFile));
  }
  if (coastlineFile) {
    configArgs.push("--coastline", basename(coastlineFile));
  }
  if (envBool("SKIP_TILES")) {
    configArgs.push("--no-tiles");
  }
  if (regions.length > 0) {
    configArgs.push(...regions);
  }
  runCommand(configArgs, repoDir);
}

async function main(): Promise<void> {
  const outDir = Bun.env.OUT_DIR ?? "/var/lib/motis";
  const motisConfig = Bun.env.MOTIS_CONFIG ?? `${outDir}/config.yml`;
  const regions = parseRegions(Bun.env.REGIONS);
  const concurrency = Math.max(1, parseInt(Bun.env.CONCURRENCY ?? "1", 10) || 1);
  if (process.env.ALLOW_FETCH_ERRORS === undefined) {
    process.env.ALLOW_FETCH_ERRORS = "1";
  }

  const osmUrl = Bun.env.OSM_URL;
  let osmFile = Bun.env.OSM_FILE;
  const coastlineUrl = Bun.env.COASTLINE_URL;
  let coastlineFile = Bun.env.COASTLINE_FILE;

  const forceOsm = envBool("FORCE_OSM_DOWNLOAD");
  const forceCoastline = envBool("FORCE_COASTLINE_DOWNLOAD");

  await mkdir(outDir, { recursive: true });
  await ensureOutSymlink(outDir);

  // Clean up temp files from interrupted postprocessing
  const entries = await readdir(outDir);
  for (const entry of entries) {
    if (entry.startsWith(".tmp-")) {
      console.log(`Cleaning up temp file: ${entry}`);
      await unlink(`${outDir}/${entry}`);
    }
  }

  // Persist downloads in the output directory
  process.env.DOWNLOADS_DIR = `${outDir}/downloads`;

  // Download OSM and Coastline in parallel
  const downloads: Promise<void>[] = [];
  if (osmUrl) {
    if (!osmFile) {
      osmFile = `${outDir}/${basename(new URL(osmUrl).pathname)}`;
    }
    downloads.push(downloadIfNeeded(osmUrl, osmFile, forceOsm));
  }

  if (coastlineUrl) {
    if (!coastlineFile) {
      coastlineFile = `${outDir}/${basename(new URL(coastlineUrl).pathname)}`;
    }
    downloads.push(downloadIfNeeded(coastlineUrl, coastlineFile, forceCoastline));
  }

  if (downloads.length > 0) {
    console.log(`Downloading ${downloads.length} files in parallel...`);
    await Promise.all(downloads);
  }

  await fetchFeeds(regions, concurrency, osmFile, coastlineFile);

  try {
    await stat(motisConfig);
  } catch {
    throw new Error(`Generated config not found at ${motisConfig}.`);
  }

  runCommand(["/opt/motis/motis", "import", "-c", motisConfig], outDir);

  // Create marker file to signal successful import
  await Bun.write(`${outDir}/.import-complete`, new Date().toISOString());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
