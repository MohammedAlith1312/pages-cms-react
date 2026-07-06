import { Router, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index";
import { cacheFileTable, cachePermissionTable, configTable } from "../db/schema";
import { requireAuth } from "./shared";

import { requireGithubRepoWriteAccess } from "../lib/authz-server";
import { getConfig } from "../lib/config-store";
import { isCacheEnabled } from "../lib/config";
import {
  getCacheFileMeta,
  listCacheFileMeta,
  deleteCacheFileMeta,
  upsertCacheFileMeta,
} from "../lib/github-cache-meta";
import { clearPermissionCache } from "../lib/github-cache-permissions";
import {
  ensureFileCacheFreshness,
  clearFileCache,
  getBranchHeadSha,
} from "../lib/github-cache-file";
import { createHttpError, sendErrorResponse } from "../lib/api-error";

const router = Router();

/* ==========================================
   8. CACHE MANAGEMENT ENDPOINTS
   ========================================== */
router.get("/api/:owner/:repo/:branch/cache", requireAuth, async (req: any, res: Response) => {
  try {
    const { owner, repo, branch } = req.params;
    const { token } = await requireGithubRepoWriteAccess(req.user, owner, repo, "Only GitHub users can view cache status.");

    const config = await getConfig(owner, repo, branch, {
      sync: true, getToken: async () => token, backgroundRefreshWhenStale: true,
    });
    if (!config?.object || !isCacheEnabled(config.object)) {
      throw createHttpError("Cache is disabled for this repository.", 403);
    }

    const meta = await getCacheFileMeta(owner, repo, branch);
    const metaEntries = await listCacheFileMeta(owner, repo, branch);
    const folderMeta = metaEntries.filter((entry) => entry.context !== "branch");

    const fileCountResult = await db.select({ count: sql<number>`count(*)` }).from(cacheFileTable)
      .where(and(
        eq(cacheFileTable.owner, owner.toLowerCase()),
        eq(cacheFileTable.repo, repo.toLowerCase()),
        eq(cacheFileTable.branch, branch),
      ));

    const permissionCountResult = await db.select({ count: sql<number>`count(*)` }).from(cachePermissionTable)
      .where(and(
        eq(cachePermissionTable.owner, owner.toLowerCase()),
        eq(cachePermissionTable.repo, repo.toLowerCase()),
      ));

    const cachedConfig = await db.query.configTable.findFirst({
      where: and(
        sql`lower(${configTable.owner}) = lower(${owner})`,
        sql`lower(${configTable.repo}) = lower(${repo})`,
        eq(configTable.branch, branch),
      ),
    });
    const branchHeadSha = await getBranchHeadSha(owner, repo, branch, token);

    res.json({
      status: "success",
      data: {
        fileMeta: meta ?? null,
        folderMeta,
        fileCount: Number(fileCountResult[0]?.count || 0),
        permissionCount: Number(permissionCountResult[0]?.count || 0),
        config: cachedConfig ? {
          sha: cachedConfig.sha,
          lastCheckedAt: cachedConfig.lastCheckedAt,
          version: cachedConfig.version,
        } : null,
        branchHeadSha,
      },
    });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

router.post("/api/:owner/:repo/:branch/cache", requireAuth, async (req: any, res: Response) => {
  try {
    const { owner, repo, branch } = req.params;
    const { action } = req.body;
    const { token } = await requireGithubRepoWriteAccess(req.user, owner, repo, "Only GitHub users can manage cache.");

    const config = await getConfig(owner, repo, branch, {
      sync: true, getToken: async () => token, backgroundRefreshWhenStale: true,
    });
    if (!config?.object || !isCacheEnabled(config.object)) {
      throw createHttpError("Cache is disabled for this repository.", 403);
    }

    switch (action) {
      case "reconcile-file-cache":
        await ensureFileCacheFreshness(owner, repo, branch, token, { force: true });
        return res.json({ status: "success", message: "File cache reconciled." });
      case "clear-file-cache":
        await clearFileCache(owner, repo, branch);
        await deleteCacheFileMeta(owner, repo, branch);
        await upsertCacheFileMeta(owner, repo, branch, { commitSha: null, status: "ok", error: null });
        return res.json({ status: "success", message: "File cache cleared." });
      case "clear-permission-cache":
        await clearPermissionCache(owner, repo);
        return res.json({ status: "success", message: "Permission cache cleared." });
      case "refresh-config":
        await getConfig(owner, repo, branch, { sync: true, getToken: async () => token, ttlMs: 0 });
        return res.json({ status: "success", message: "Config cache refreshed." });
      case "clear-config-cache":
        await db.delete(configTable).where(and(
          sql`lower(${configTable.owner}) = lower(${owner})`,
          sql`lower(${configTable.repo}) = lower(${repo})`,
          eq(configTable.branch, branch),
        ));
        return res.json({ status: "success", message: "Config cache cleared." });
      case "clear-all-cache":
        await clearFileCache(owner, repo, branch);
        await deleteCacheFileMeta(owner, repo, branch);
        await upsertCacheFileMeta(owner, repo, branch, { commitSha: null, status: "ok", error: null });
        await clearPermissionCache(owner, repo);
        await db.delete(configTable).where(and(
          sql`lower(${configTable.owner}) = lower(${owner})`,
          sql`lower(${configTable.repo}) = lower(${repo})`,
          eq(configTable.branch, branch),
        ));
        return res.json({ status: "success", message: "All cache cleared." });
      default:
        throw createHttpError(`Invalid action "${action}".`, 400);
    }
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

export { router };
