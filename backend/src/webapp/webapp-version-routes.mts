import express from "express";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ApiUri } from "../types.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface BuildInfo {
  version: string;
  gitHash: string;
  buildTime: string;
  dirty: boolean;
}

/** Read build-info.json once at startup */
function loadBuildInfo(): BuildInfo {
  try {
    const infoPath = join(__dirname, "..", "build-info.json");
    return JSON.parse(readFileSync(infoPath, "utf-8")) as BuildInfo;
  } catch {
    return { version: "unknown", gitHash: "unknown", buildTime: "unknown", dirty: false };
  }
}

export const buildInfo = loadBuildInfo();
const startTime = new Date().toISOString();

/**
 * GET /api/version - Returns build info and server start time.
 *
 * Used by E2E tests to verify the backend is running the expected build.
 */
export function registerVersionRoutes(app: express.Application): void {
  app.get(ApiUri.Version, (_req, res) => {
    res.json({ ...buildInfo, startTime });
  });
}
