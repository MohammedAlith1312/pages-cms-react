import { createHttpError } from "./api-error.ts";
import { getConfig } from "./config-store.ts";
import { getGithubId } from "./github-account.ts";
import { checkRepoAccess } from "./github-cache-permissions.ts";
import { getToken } from "./token.ts";
import type { Config } from "../types/config.ts";
import type { User } from "../types/user.ts";

type RepoRef = {
  owner: string;
  repo: string;
  branch: string;
};

type RepoReadContext = {
  user: User;
  token: string;
  config: Config;
};

const getRepoReadContext = async (user: User, { owner, repo, branch }: RepoRef): Promise<RepoReadContext> => {
  const { token, source } = await getToken(user, owner, repo);
  if (!token) throw createHttpError("Token not found", 401);

  const githubId = await getGithubId(user.id);
  if (githubId && source === "user") {
    const hasAccess = await checkRepoAccess(token, owner, repo, githubId);
    if (!hasAccess) throw createHttpError(`No access to repository ${owner}/${repo}.`, 403);
  }

  const config = await getConfig(owner, repo, branch, {
    getToken: async () => token,
  });
  if (!config) throw createHttpError(`Configuration not found for ${owner}/${repo}/${branch}.`, 404);

  return { user, token, config };
};

export { getRepoReadContext };
