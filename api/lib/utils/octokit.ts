import { Octokit } from "@octokit/rest";
import { createHttpError } from "../api-error.ts";

const getRetryAfter = (response: any) => {
  const retryAfter = response.headers ? response.headers["retry-after"] : null;
  if (retryAfter) return retryAfter;

  const remaining = response.headers ? response.headers["x-ratelimit-remaining"] : null;
  const reset = response.headers ? response.headers["x-ratelimit-reset"] : null;
  if (remaining !== "0" || !reset) return null;

  const resetSeconds = Number(reset);
  if (!Number.isFinite(resetSeconds)) return null;

  return String(Math.max(1, resetSeconds - Math.floor(Date.now() / 1000)));
};

const isGithubRateLimitResponse = (response: any, message: string) => {
  if (response.status !== 403 && response.status !== 429) return false;

  const normalizedMessage = message.toLowerCase();
  return (
    normalizedMessage.includes("rate limit") ||
    (response.headers && response.headers["x-ratelimit-remaining"] === "0") ||
    Boolean(response.headers && response.headers["retry-after"])
  );
};

export const createOctokitInstance = (token: string, options?: any) => {
  if (!token) throw new Error("Auth token is required to initialize Octokit");

  return new Octokit({
    ...options,
    auth: token,
    request: {
      fetch: async (url: string, options: RequestInit) => {
        const response = await fetch(url, options);

        if (response.status === 401 || response.status === 403 || response.status === 429) {
          let message = response.status === 401
            ? "GitHub authentication failed."
            : "GitHub request failed.";

          try {
            const data = (await response.clone().json()) as any;
            if (typeof data.message === "string") {
              message = data.message;
            }
            if (response.status === 401 && data.message === "Bad credentials") {
              message = "GitHub authentication failed: bad credentials.";
            }
          } catch {}

          if (response.status === 401) {
            throw createHttpError(message, 401);
          }

          if (isGithubRateLimitResponse(response, message)) {
            const retryAfter = getRetryAfter(response);
            throw createHttpError(
              retryAfter
                ? `GitHub rate limit reached. Please wait ${retryAfter} seconds and try again.`
                : "GitHub rate limit reached. Please wait a minute and try again.",
              429,
              retryAfter ? { "Retry-After": retryAfter } : undefined,
            );
          }
        }

        return response;
      }
    }
  });
};
