#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2024 Jonah Brüchert <jbb@kaidan.im>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from "node:child_process";

function envBool(name: string, fallback = false): boolean {
  const value = Bun.env[name];
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

type CronSpec = {
  minute: number;
  hour: number;
};

function runUpdate(): void {
  const result = spawnSync("bun", ["/opt/transitous/motis/update_data.ts"], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Update failed with exit code ${result.status}`);
  }
}

function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid UPDATE_CRON expression: ${expression}`);
  }

  const [minuteField, hourField, dayField, monthField, weekdayField] = fields;
  if (dayField !== "*" || monthField !== "*" || weekdayField !== "*") {
    throw new Error("UPDATE_CRON only supports minute/hour fields with '*' for day/month/weekday.");
  }

  const minute = Number.parseInt(minuteField, 10);
  const hour = Number.parseInt(hourField, 10);
  if (Number.isNaN(minute) || minute < 0 || minute > 59) {
    throw new Error(`Invalid minute in UPDATE_CRON: ${minuteField}`);
  }
  if (Number.isNaN(hour) || hour < 0 || hour > 23) {
    throw new Error(`Invalid hour in UPDATE_CRON: ${hourField}`);
  }

  return { minute, hour };
}

function nextRun(now: Date, hour: number, minute: number): Date {
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate <= now) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const cronExpression = Bun.env.UPDATE_CRON ?? "0 2 * * *";
  const runOnStart = envBool("RUN_ON_START", true);

  const timezone = Bun.env.UPDATE_TZ ?? "UTC";
  process.env.TZ = timezone;
  const schedule = parseCron(cronExpression);

  if (runOnStart) {
    runUpdate();
  }

  while (true) {
    const now = new Date();
    const scheduled = nextRun(now, schedule.hour, schedule.minute);
    const sleepMs = Math.max(0, scheduled.getTime() - now.getTime());
    console.log(`Next update scheduled at ${scheduled.toISOString()} (${timezone}).`);
    await sleep(sleepMs);
    try {
      runUpdate();
    } catch (error) {
      console.error(error);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
