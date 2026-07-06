import { Router, Response } from "express";
import mergeWith from "lodash.mergewith";
import { requireAuth } from "./shared";

import { getToken } from "../lib/token";
import {
  normalizePath,
  getFileExtension,
  getFileName,
  getParentPath,
  serializedTypes,
} from "../lib/utils/file";
import { getConfig, updateConfig } from "../lib/config-store";
import {
  getSchemaByName,
  generateZodSchema,
  deepMap,
  sanitizeObject,
} from "../lib/schema";
import { writeFns } from "../fields/registry";
import { createOctokitInstance } from "../lib/utils/octokit";
import {
  resolveCommitIdentity,
  resolveCommitMessage,
  buildCommitTokens,
} from "../lib/commit-message";
import { assertGithubIdentity } from "../lib/authz-shared";
import { configVersion, parseConfig, normalizeConfig } from "../lib/config";
import { updateFileCache, getMediaCache } from "../lib/github-cache-file";
import { parse, stringify } from "../lib/serialization";
import { getRepoReadContext } from "../lib/api-repo-context";
import { createHttpError, sendErrorResponse } from "../lib/api-error";

const router = Router();

/* ==========================================
   5. FILES PATH (POST/DELETE)
   ========================================== */
router.post("/api/:owner/:repo/:branch/files/:path(*)", requireAuth, async (req: any, res: Response) => {
  try {
    const { owner, repo, branch, path: rawPath } = req.params;
    const { token } = await getToken(req.user, owner, repo, true);
    if (!token) throw new Error("Token not found");

    const normalizedPath = normalizePath(rawPath);
    const config = await getConfig(owner, repo, branch, {
      getToken: async () => token,
    });
    if (!config && normalizedPath !== ".pages.yml") throw new Error(`Configuration not found for ${owner}/${repo}/${branch}.`);

    const data: any = req.body;
    const onConflict = data.onConflict === "error" ? "error" : "rename";

    let contentBase64;
    let schema;
    let schemaCommitTemplates: Record<string, string> | undefined;
    let schemaCommitIdentity: "app" | "user" | undefined;

    switch (data.type) {
      case "content":
        if (!data.name) throw new Error(`"name" is required for content.`);
        schema = getSchemaByName(config?.object, data.name);
        if (!schema) throw new Error(`Content schema not found for ${data.name}.`);
        schemaCommitTemplates = schema?.commit?.templates;
        schemaCommitIdentity = schema?.commit?.identity;

        if (!normalizedPath.startsWith(schema.path)) throw new Error(`Invalid path "${rawPath}" for ${data.type} "${data.name}".`);

        if (schema.subfolders === false && getParentPath(normalizedPath) !== schema.path) {
          throw new Error(`Subfolders are not allowed for collection "${data.name}".`);
        }

        if (getFileName(normalizedPath) === ".gitkeep") {
          contentBase64 = "";
        } else {
          if (getFileExtension(normalizedPath) !== (schema.extension ?? "")) throw new Error(`Invalid extension "${getFileExtension(normalizedPath)}" for ${data.type} "${data.name}".`);

          if (serializedTypes.includes(schema.format) && schema.fields) {
            let contentFields;
            let contentObject;

            if (schema.list) {
              contentObject = { listWrapper: data.content };
              contentFields = [{
                name: "listWrapper",
                type: "object",
                list: true,
                fields: schema.fields
              }];
            } else {
              contentObject = data.content;
              contentFields = schema.fields;
            }

            const zodSchema = generateZodSchema(contentFields);
            const zodValidation = zodSchema.safeParse(contentObject);

            if (zodValidation.success === false) {
              const errorMessages = zodValidation.error.errors.map((error: any) => {
                let msg = error.message;
                if (error.path.length > 0) msg = `${msg} at ${error.path.join(".")}`;
                return msg;
              });
              throw new Error(`Content validation failed: ${errorMessages.join(", ")}`);
            }

            const validatedContentObject = deepMap(
              zodValidation.data,
              contentFields,
              (value: any, field: any) => {
                const fieldType = field.type as string;
                return writeFns[fieldType] ? writeFns[fieldType](value, field, config || {}) : value;
              }
            );

            const unwrappedContentObject = schema.list ? validatedContentObject.listWrapper : validatedContentObject;
            let finalContentObject = JSON.parse(JSON.stringify(unwrappedContentObject));

            if (config?.object?.settings?.content?.merge && data.sha && !schema.list) {
              const octokit = createOctokitInstance(token);
              const response = await octokit.rest.repos.getContent({
                owner,
                repo,
                path: normalizedPath,
                ref: branch
              });

              if (Array.isArray(response.data)) {
                throw new Error("Expected a file but found a directory");
              } else if (response.data.type !== "file") {
                throw new Error("Invalid response type");
              }

              const existingContent = Buffer.from(response.data.content, "base64").toString();
              const existingContentObject = parse(existingContent, { format: schema.format, delimiters: schema.delimiters });

              finalContentObject = mergeWith({}, existingContentObject, unwrappedContentObject, (objValue: any, srcValue: any) => {
                if (Array.isArray(srcValue)) return srcValue;
              });
            }

            const stringifiedContentObject = stringify(
              sanitizeObject(finalContentObject),
              { format: schema.format, delimiters: schema.delimiters }
            );
            contentBase64 = Buffer.from(stringifiedContentObject).toString("base64");
          } else {
            contentBase64 = Buffer.from(data.content?.body ?? "").toString("base64");
          }
        }
        break;
      case "media":
        if (!data.name) throw new Error(`"name" is required for media.`);
        schema = getSchemaByName(config?.object, data.name, "media");
        if (!schema) throw new Error(`Media schema not found for ${data.name}.`);
        schemaCommitTemplates = schema?.commit?.templates;
        schemaCommitIdentity = schema?.commit?.identity;

        if (!normalizedPath.startsWith(schema.input)) throw new Error(`Invalid path "${rawPath}" for media "${data.name}".`);

        if (getFileName(normalizedPath) === ".gitkeep") {
          contentBase64 = "";
        } else {
          if (
            schema.extensions?.length > 0 &&
            !schema.extensions.includes(getFileExtension(normalizedPath))
          ) throw new Error(`Invalid extension "${getFileExtension(normalizedPath)}" for media.`);

          contentBase64 = data.content;
        }
        break;
      case "settings":
        assertGithubIdentity(req.user, "Only GitHub users can manage settings.");
        if (normalizedPath !== ".pages.yml") throw new Error(`Invalid path "${rawPath}" for settings.`);
        contentBase64 = Buffer.from(data.content?.body ?? "").toString("base64");
        break;
      default:
        throw new Error(`Invalid type "${data.type}".`);
    }

    const commitIdentity = resolveCommitIdentity({
      configObject: config?.object,
      identityOverride: schemaCommitIdentity,
    });
    const committer = (commitIdentity === "user" && req.user.email)
      ? { name: req.user.name?.trim() || req.user.email, email: req.user.email }
      : undefined;

    // Save file on GitHub using octokit helper
    const response = await githubSaveFile(
      token, owner, repo, branch, normalizedPath, contentBase64, data.sha,
      {
        configObject: config?.object,
        templatesOverride: schemaCommitTemplates,
        contentName: data.name,
        user: req.user.email || req.user.name || String(req.user.id || ""),
        onConflict,
        committer,
      }
    );

    const savedPath = response?.data.content?.path;

    let newConfig;
    if (data.type === "settings") {
      const parsedConfig = parseConfig(data.content?.body ?? "");
      const configObject = normalizeConfig(parsedConfig.document.toJSON());
      newConfig = {
        owner, repo, branch,
        sha: response?.data.content?.sha as string,
        version: configVersion ?? "0.0",
        object: configObject
      };
      await updateConfig(newConfig);
    }

    if (response?.data.content && response?.data.commit) {
      await updateFileCache(
        data.type === 'content' ? 'collection' : 'media',
        owner, repo, branch,
        {
          type: data.sha ? 'modify' : 'add',
          path: response.data.content.path!,
          sha: response.data.content.sha!,
          content: Buffer.from(contentBase64, 'base64').toString('utf-8'),
          size: response.data.content.size,
          downloadUrl: response.data.content.download_url,
          commit: {
            sha: response.data.commit.sha!,
            timestamp: new Date(response.data.commit.committer?.date ?? new Date().toISOString()).getTime()
          }
        }
      );
    }

    res.json({
      status: "success",
      message: savedPath !== normalizedPath
        ? `File "${normalizedPath}" saved successfully but renamed to "${savedPath}" to avoid naming conflict.`
        : `File "${normalizedPath}" saved successfully.`,
      data: {
        type: response?.data.content?.type,
        sha: response?.data.content?.sha,
        name: response?.data.content?.name,
        path: savedPath,
        extension: getFileExtension(response?.data.content?.name || ""),
        size: response?.data.content?.size,
        url: response?.data.content?.download_url,
        config: newConfig ?? undefined,
      }
    });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

// githubSaveFile helper function ported
const githubSaveFile = async (
  token: string, owner: string, repo: string, branch: string, path: string, contentBase64: string, sha?: string,
  options?: any
) => {
  const octokit = createOctokitInstance(token, { retry: { doNotRetry: [409] } });
  const message = resolveCommitMessage({
    configObject: options?.configObject,
    templatesOverride: options?.templatesOverride,
    action: sha ? "update" : "create",
    tokens: buildCommitTokens({
      action: sha ? "update" : "create",
      owner, repo, branch, path,
      contentName: options?.contentName,
      user: options?.user,
      userName: options?.committer?.name,
      userEmail: options?.committer?.email,
    }),
  });

  try {
    const response = await octokit.rest.repos.createOrUpdateFileContents({
      owner, repo, path, message, content: contentBase64, branch,
      sha: sha || undefined, committer: options?.committer,
    });
    if (response.data.content && response.data.commit) return response;
    throw new Error("Invalid response structure");
  } catch (error: any) {
    if (error.status === 409) {
      if (typeof error?.response?.data?.message === "string" && error.response.data.message.includes("Repository rule violations found")) {
        throw createHttpError("This repository requires changes through a PR.", 409);
      }
      if (sha) throw createHttpError("File has changed since you last loaded it.", 409);
    }

    if (error.status === 422 && !sha) {
      if (options?.onConflict === "error") throw createHttpError(`File "${path}" already exists.`, 409);
      const parentDir = getParentPath(path);
      const { data } = await octokit.rest.repos.getContent({
        owner, repo, path: parentDir || '.', ref: branch,
      });

      if (!Array.isArray(data)) throw new Error('Expected directory listing');

      const basename = path.split('/').pop() || "";
      const lastDotIndex = basename.lastIndexOf(".");
      const filename = lastDotIndex > 0 ? basename.slice(0, lastDotIndex) : basename;
      const extension = lastDotIndex > 0 ? basename.slice(lastDotIndex + 1) : "";
      const pattern = extension ? new RegExp(`^${filename}-(\\d+)\\.${extension}$`) : new RegExp(`^${filename}-(\\d+)$`);
      const maxNumber = Math.max(0, ...data.map(file => {
        const m = file.name.match(pattern);
        return m ? parseInt(m[1], 10) : 0;
      }));

      for (let i = 1; i <= 3; i++) {
        const candidate = extension ? `${filename}-${maxNumber + i}.${extension}` : `${filename}-${maxNumber + i}`;
        const newPath = `${parentDir ? parentDir + '/' : ''}${candidate}`;
        try {
          return await octokit.rest.repos.createOrUpdateFileContents({
            owner, repo, path: newPath, message, content: contentBase64, branch,
            committer: options?.committer,
          });
        } catch (err: any) {
          if (i === 3 || err.status !== 422) throw err;
        }
      }
    }
    throw error;
  }
};

router.delete("/api/:owner/:repo/:branch/files/:path(*)", requireAuth, async (req: any, res: Response) => {
  try {
    const { owner, repo, branch, path: rawPath } = req.params;
    const { token } = await getToken(req.user, owner, repo, true);
    if (!token) throw new Error("Token not found");

    const normalizedPath = normalizePath(rawPath);
    if (normalizedPath === ".pages.yml") throw createHttpError("Deleting settings file isn't allowed.", 403);

    const sha = req.query.sha as string;
    const type = req.query.type as string;
    const name = req.query.name as string;

    if (!type || !["content", "media"].includes(type)) throw new Error(`"type" is required.`);
    if (!sha) throw new Error(`"sha" is required.`);

    const config = await getConfig(owner, repo, branch, { getToken: async () => token });
    if (!config) throw new Error("Configuration not found.");

    let schema;
    let schemaCommitTemplates;
    let schemaCommitIdentity;

    if (type === "content") {
      schema = getSchemaByName(config.object, name);
      if (!schema) throw new Error("Content schema not found.");
      schemaCommitTemplates = schema?.commit?.templates;
      schemaCommitIdentity = schema?.commit?.identity;
    } else {
      schema = getSchemaByName(config.object, name, "media");
      if (!schema) throw new Error("Media schema not found.");
      schemaCommitTemplates = schema?.commit?.templates;
      schemaCommitIdentity = schema?.commit?.identity;
    }

    const commitIdentity = resolveCommitIdentity({
      configObject: config.object,
      identityOverride: schemaCommitIdentity,
    });
    const committer = (commitIdentity === "user" && req.user.email)
      ? { name: req.user.name?.trim() || req.user.email, email: req.user.email }
      : undefined;

    const octokit = createOctokitInstance(token);
    const response = await octokit.rest.repos.deleteFile({
      owner, repo, branch, path: normalizedPath, sha,
      message: resolveCommitMessage({
        configObject: config.object,
        templatesOverride: schemaCommitTemplates,
        action: "delete",
        tokens: buildCommitTokens({
          action: "delete", owner, repo, branch, path: normalizedPath, contentName: name,
          user: req.user.email || req.user.name || String(req.user.id || ""),
          userName: committer?.name, userEmail: committer?.email,
        }),
      }),
      committer,
    });

    await updateFileCache(
      type === "content" ? "collection" : "media",
      owner, repo, branch,
      {
        type: 'delete',
        path: normalizedPath,
        commit: response?.data.commit?.sha ? {
          sha: response.data.commit.sha,
          timestamp: new Date(response.data.commit.committer?.date ?? new Date().toISOString()).getTime(),
        } : undefined,
      }
    );

    res.json({
      status: "success",
      message: `File "${normalizedPath}" deleted successfully.`,
      data: { sha: response?.data.commit.sha, name: response?.data.content?.name, path: response?.data.content?.path }
    });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

/* ==========================================
   6. MEDIA GET ENDPOINT
   ========================================== */
router.get("/api/:owner/:repo/:branch/media/:name/:path(*)", requireAuth, async (req: any, res: Response) => {
  try {
    const { owner, repo, branch, name, path: rawPath } = req.params;
    const { token, config } = await getRepoReadContext(req.user, { owner, repo, branch });

    const mediaConfig = config.object.media?.find((item: any) => item.name === name) || config.object.media?.[0];
    if (!mediaConfig) throw createHttpError(`No media configuration found.`, 404);

    const normalizedPath = normalizeMediaPath(rawPath, owner, repo, branch);
    if (!normalizedPath.startsWith(mediaConfig.input)) throw createHttpError(`Invalid path for media.`, 400);

    const nocache = req.query.nocache === "true";
    let results;
    try {
      results = await getMediaCache(owner, repo, branch, normalizedPath, token, nocache);
    } catch (err: any) {
      if (err?.status === 404) results = [];
      else throw err;
    }

    if (mediaConfig.extensions && mediaConfig.extensions.length > 0) {
      results = results.filter((item) => {
        if (item.type === "dir") return true;
        return mediaConfig.extensions.includes(getFileExtension(item.name));
      });
    }

    results.sort((a: any, b: any) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === "dir" ? -1 : 1;
    });

    res.json({
      status: "success",
      data: results.map((item: any) => ({
        type: item.type,
        sha: item.sha,
        name: item.name,
        path: item.path,
        extension: item.type === "dir" ? undefined : getFileExtension(item.name),
        size: item.size,
        url: item.downloadUrl
      })),
    });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

const normalizeMediaPath = (rawPath: string, owner: string, repo: string, branch: string) => {
  const decodedPath = decodeURIComponent(rawPath || "");
  const markdownMatch = decodedPath.match(/^\[.*?\]\((.+)\)$/);
  const markdownLooseMatch = decodedPath.match(/^\[.*?\]\((.+)$/);
  const candidate = (markdownMatch?.[1] || markdownLooseMatch?.[1]?.replace(/\)$/, "") || decodedPath).trim();

  let repoRelativePath = candidate;
  if (candidate.startsWith("https://raw.githubusercontent.com/")) {
    try {
      const url = new URL(candidate);
      const pathname = decodeURIComponent(url.pathname || "");
      const branchPrefix = `/${owner}/${repo}/${branch}/`;
      if (pathname.startsWith(branchPrefix)) {
        repoRelativePath = pathname.slice(branchPrefix.length);
      }
    } catch {
      repoRelativePath = candidate;
    }
  }
  repoRelativePath = repoRelativePath.split("#")[0]?.split("?")[0] || repoRelativePath;
  return normalizePath(repoRelativePath);
};

export { router };
