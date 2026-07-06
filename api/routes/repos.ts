import { Router, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index";
import { collaboratorTable } from "../db/schema";
import { requireAuth } from "./shared";

import { getGithubAccount } from "../lib/github-account";
import { hasGithubIdentity } from "../lib/authz-shared";
import { getInstallations, getInstallationRepos } from "../lib/github-app";
import { createOctokitInstance } from "../lib/utils/octokit";
import { createHttpError, sendErrorResponse } from "../lib/api-error";
import { getRepoSnapshot } from "../lib/github-cache-file";
import { getToken } from "../lib/token";
import { getAccounts } from "../lib/accounts";
import { hasAdminAccess } from "../lib/admin";
import { requireGithubUserToken } from "../lib/authz-server";

const router = Router();

/* ==========================================
   1. REPOS ENDPOINT
   ========================================== */
router.get("/api/repos/:owner", requireAuth, async (req: any, res: Response) => {
  try {
    const { owner } = req.params;
    const user = req.user;

    let githubRepos: any[] = [];
    let collaboratorRepos: any[] = [];

    const type = (req.query.type as string) || "owner";
    const repositorySelection = req.query.repository_selection as string;
    const keyword = (req.query.keyword as string) || "";

    const githubAccount = await getGithubAccount(user.id);
    if (githubAccount?.accessToken && hasGithubIdentity(user)) {
      const token = githubAccount.accessToken;

      if (repositorySelection === "selected") {
        const installations = await getInstallations(token, [owner]);
        if (installations.length === 1) {
          githubRepos = await getInstallationRepos(token, installations[0].id);
        }
      } else {
        const octokit = createOctokitInstance(token);
        const query = `${keyword} in:name ${type}:${owner} fork:true`;
        const response = await octokit.rest.search.repos({
          q: query,
          sort: "updated",
          order: "desc",
          per_page: 5
        });
        githubRepos = response.data.items;
      }

      githubRepos = githubRepos
        .filter(repo => repo.permissions?.push)
        .map(repo => ({
          owner: repo.owner.login,
          repo: repo.name,
          private: repo.private,
          defaultBranch: repo.default_branch,
          updatedAt: repo.updated_at,
        }));
    }

    // Direct database check for collaborator repos matching user email/id
    const userEmail = user.email || "";
    collaboratorRepos = await db.query.collaboratorTable.findMany({
      where: and(
        eq(collaboratorTable.userId, user.id),
        sql`lower(${collaboratorTable.owner}) = lower(${owner})`
      )
    });

    const reposByKey = new Map<string, any>();
    for (const repo of githubRepos) {
      reposByKey.set(`${repo.owner.toLowerCase()}::${repo.repo.toLowerCase()}`, repo);
    }
    for (const repo of collaboratorRepos) {
      const key = `${repo.owner.toLowerCase()}::${repo.repo.toLowerCase()}`;
      if (!reposByKey.has(key)) {
        reposByKey.set(key, repo);
      }
    }

    res.json({
      status: "success",
      data: Array.from(reposByKey.values()),
    });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

router.get("/api/repos/:owner/:repo", requireAuth, async (req: any, res: Response) => {
  try {
    const { owner, repo } = req.params;
    const { token } = await getToken(req.user, owner, repo);
    if (!token) throw createHttpError("Token not found", 401);

    const repoInfo = await getRepoSnapshot(owner, repo, token);
    res.json({ status: "success", data: repoInfo });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

router.get("/api/users/me", requireAuth, async (req: any, res: Response) => {
  try {
    const user = req.user;
    const accounts = await getAccounts(user);
    const isAdmin = hasAdminAccess(user);

    res.json({
      status: "success",
      data: {
        ...user,
        isAdmin,
        accounts,
      },
    });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

/* ==========================================
   1.5. TEMPLATE COPY ENDPOINT
   ========================================== */
router.post("/api/templates/copy", requireAuth, async (req: any, res: Response) => {
  try {
    const { template, owner, name } = req.body;
    const user = req.user;

    const token = await requireGithubUserToken(user, "You must be signed in with GitHub to copy a template.");

    const installations = await getInstallations(token, [owner]);
    if (installations.length !== 1) {
      return res.status(400).json({ status: "error", message: `"${owner}" is not part of your GitHub App installations` });
    }

    const [template_owner, template_repo] = template.split("/");
    const octokit = createOctokitInstance(token);
    const response = await octokit.rest.repos.createUsingTemplate({
      template_owner,
      template_repo,
      owner,
      name,
    });

    res.json({
      status: "success",
      message: `"${template}" successfully copied as "${response.data.full_name}".`,
      data: {
        template,
        owner,
        repo: name,
        branch: response.data.default_branch
      }
    });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ status: "error", message: error.response?.data?.message || error.message });
  }
});

export { router };
