import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import path from "path";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db/index.ts";
import {
  collaboratorInviteTable,
  collaboratorTable,
  cacheFileTable,
  cachePermissionTable,
  configTable,
  githubInstallationTokenTable,
} from "./db/schema.ts";

// Helper & Lib imports
import { getRepoReadContext } from "./lib/api-repo-context.ts";
import { createHttpError, sendErrorResponse } from "./lib/api-error.ts";
import { getConfig, saveConfig, updateConfig } from "./lib/config-store.ts";
import { getGithubAccount, getGithubId } from "./lib/github-account.ts";
import { hasGithubIdentity, assertGithubIdentity } from "./lib/authz-shared.ts";
import { requireGithubUserToken, requireGithubRepoWriteAccess } from "./lib/authz-server.ts";
import { getInstallations, getInstallationRepos } from "./lib/github-app.ts";
import { createOctokitInstance } from "./lib/utils/octokit.ts";
import { getFileExtension, getFileName, normalizePath, serializedTypes, getParentPath } from "./lib/utils/file.ts";
import { isCacheEnabled, configVersion, parseConfig, normalizeConfig } from "./lib/config.ts";
import { readFns, writeFns } from "./fields/registry.ts";
import { parse, stringify } from "./lib/serialization.ts";
import { deepMap, generateZodSchema, getSchemaByName, sanitizeObject, getDateFromFilename, getFieldByPath, safeAccess } from "./lib/schema.ts";
import mergeWith from "lodash.mergewith";
import { buildCommitTokens, resolveCommitIdentity, resolveCommitMessage } from "./lib/commit-message.ts";
import {
  getCollectionCache,
  getMediaCache,
  ensureFileCacheFreshness,
  clearFileCache,
  updateFileCache,
  getRepoSnapshot,
} from "./lib/github-cache-file.ts";
import { getCacheFileMeta, listCacheFileMeta, deleteCacheFileMeta, upsertCacheFileMeta } from "./lib/github-cache-meta.ts";
import { clearPermissionCache } from "./lib/github-cache-permissions.ts";
import { getBranchHeadSha, getBranchHeadInfo } from "./lib/github-cache-file.ts";
import { getToken, getInstallationToken } from "./lib/token.ts";
import { sendEmail } from "./lib/mailer.ts";
import { getBaseUrl } from "./lib/base-url.ts";
import { findVerifiedUserByEmail, normalizeEmail } from "./lib/collaborator-access.ts";
import { getAccounts } from "./lib/accounts.ts";
import { hasAdminAccess } from "./lib/admin.ts";

// Webhook event handlers
import { handleInstallationWebhookEvent } from "./lib/github-webhook-installation.ts";
import { handlePushWebhookEvent } from "./lib/github-webhook-push.ts";
import { handleActionWebhookEvent } from "./lib/github-webhook-actions.ts";

const router = Router();

// Express Auth Middleware using req.session or Better Auth context
const requireAuth = (req: any, res: Response, next: NextFunction) => {
  // Better Auth mounts authenticated session user in req.user
  if (!req.user) {
    return res.status(401).json({ status: "error", message: "Unauthorized. Please sign in." });
  }
  next();
};

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

/* ==========================================
   2. CONFIG ENDPOINT
   ========================================== */
router.get("/api/:owner/:repo/:branch/config", requireAuth, async (req: any, res: Response) => {
  try {
    const { owner, repo, branch } = req.params;
    const { token } = await getToken(req.user, owner, repo);
    if (!token) throw createHttpError("Token not found", 401);

    const config = await getConfig(owner, repo, branch, {
      sync: true,
      getToken: async () => token,
    });

    if (!config) {
      return res.status(404).json({ status: "error", message: "Config not found" });
    }

    res.json({ status: "success", data: config });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

/* ==========================================
   3. COLLECTIONS ENDPOINT
   ========================================== */
router.get("/api/:owner/:repo/:branch/collections/:name", requireAuth, async (req: any, res: Response) => {
  try {
    const { owner, repo, branch, name } = req.params;
    const { token, config } = await getRepoReadContext(req.user, { owner, repo, branch });

    const schema = getSchemaByName(config.object, name);
    if (!schema) throw createHttpError(`Schema not found for ${name}.`, 404);

    const path = (req.query.path as string) || "";
    const type = req.query.type as string;
    const query = (req.query.query as string) || "";
    const fields = (req.query.fields as string)?.split(",") || ["name"];

    const normalizedPath = normalizePath(path);
    if (!normalizedPath.startsWith(schema.path)) throw createHttpError(`Invalid path "${path}" for collection "${name}".`, 400);

    if (schema.subfolders === false) {
      if (normalizedPath !== schema.path) throw createHttpError(`Invalid path "${path}" for collection "${name}".`, 400);
    }

    let entries = await getCollectionCache(owner, repo, branch, normalizedPath, token, schema.view?.node?.filename);

    let data: {
      contents: Record<string, any>[],
      errors: string[]
    } = {
      contents: [],
      errors: []
    };

    if (schema.view?.node?.filename) {
      entries = entries.filter((item: any) => item.isNode || item.parentPath === schema.path || item.name !== schema.view.node.filename);
    }

    if (['all', 'nodes', 'others'].includes(schema.view?.node?.hideDirs)) {
      if (schema.view.node.hideDirs === "all") {
        entries = entries.filter((item: any) => item.type !== "dir");
      } else if (["nodes", "others"].includes(schema.view.node.hideDirs)) {
        entries = entries.filter((item: any) =>
          item.type !== "dir" ||
          (schema.view.node.hideDirs === "others"
            ? entries.some((subItem: any) => subItem.parentPath === item.path && subItem.isNode)
            : !entries.some((subItem: any) => subItem.parentPath === item.path && subItem.isNode)
          )
        );
      }
    }

    if (entries) {
      data = parseContents(entries, schema, config, fields);

      if (type === "search" && query) {
        const searchQuery = query.toLowerCase();
        const searchFields = Array.isArray(fields) ? fields : fields ? [fields] : [];

        data.contents = data.contents.filter(item => {
          if (searchFields.length === 0) {
            if (
              (item.name && item.name.toLowerCase().includes(searchQuery)) ||
              (item.path && item.path.toLowerCase().includes(searchQuery))
            ) {
              return true;
            }
            return item.content && item.content.toLowerCase().includes(searchQuery);
          }

          return searchFields.some(field => {
            if (field === 'name' || field === 'path') {
              const value = item[field];
              return value && String(value).toLowerCase().includes(searchQuery);
            }

            if (field.startsWith('fields.')) {
              const fieldPath = field.replace('fields.', '');
              const value = safeAccess(item.fields, fieldPath);
              return value && String(value).toLowerCase().includes(searchQuery);
            }

            return false;
          });
        });
      }
    }

    res.json({ status: "success", data });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

// Parsing helper function from collections route
const parseContents = (
  contents: any,
  schema: Record<string, any>,
  config: Record<string, any>,
  selectedFields?: string[],
): { contents: Record<string, any>[], errors: string[] } => {
  const serializedTypes = ["yaml-frontmatter", "json-frontmatter", "toml-frontmatter", "yaml", "json", "toml"];
  const excludedFiles = schema.exclude || [];
  const extension = schema.extension ?? "";

  let parsedContents: Record<string, any>[] = [];
  let parsedErrors: string[] = [];

  parsedContents = contents.map((item: any) => {
    if (item.type === "file" && (extension === "" || item.path.endsWith(`.${extension}`)) && !excludedFiles.includes(item.name)) {
      let contentObject: Record<string, any> = {};

      if (serializedTypes.includes(schema.format) && schema.fields) {
        try {
          const parsedObject = parse(item.content, { format: schema.format, delimiters: schema.delimiters });
          if (Array.isArray(selectedFields) && selectedFields.length > 0) {
            const requestedFieldPaths = selectedFields
              .filter((fieldPath) => fieldPath !== "path")
              .map((fieldPath) => fieldPath.startsWith("fields.") ? fieldPath.replace(/^fields\./, "") : fieldPath);
            contentObject = pickAndTransformFields(parsedObject, schema.fields, requestedFieldPaths, config);
          } else {
            contentObject = deepMap(parsedObject, schema.fields, (value: any, field: any) => {
              if (typeof field.type === "string" && readFns[field.type]) {
                return readFns[field.type](value, field, config);
              }
              return value;
            });
          }
        } catch (error: any) {
          console.error(`Error parsing frontmatter for file "${item.path}": ${error.message}`);
          parsedErrors.push(`Error parsing frontmatter for file "${item.path}": ${error.message}`);
        }
      }

      if (!schema.fields || schema.fields.length === 0) {
        contentObject.name = item.name;
      }

      if (!contentObject.date && schema.filename?.startsWith("{year}-{month}-{day}")) {
        const filenameDate = getDateFromFilename(item.name);
        if (filenameDate) {
          contentObject.date = filenameDate.string;
        }
      }

      return {
        sha: item.sha,
        name: item.name,
        parentPath: item.parentPath,
        path: item.path,
        content: item.content,
        fields: contentObject,
        type: "file",
        isNode: item.isNode,
      };
    } else if (item.type === "dir" && !excludedFiles.includes(item.name) && schema.subfolders !== false) {
      return {
        name: item.name,
        parentPath: item.parentPath,
        path: item.path,
        type: "dir",
      };
    }
  }).filter((item: any) => item !== undefined);

  return {
    contents: parsedContents,
    errors: parsedErrors
  };
};

const pickAndTransformFields = (
  parsedObject: Record<string, any>,
  schemaFields: any[],
  fieldPaths: string[],
  config: Record<string, any>,
) => {
  const output: Record<string, any> = {};
  const dedupedPaths = Array.from(new Set(fieldPaths));

  dedupedPaths.forEach((fieldPath) => {
    const field = getFieldByPath(schemaFields, fieldPath);
    if (!field) return;

    let value = safeAccess(parsedObject, fieldPath);
    if (typeof field.type === "string" && readFns[field.type]) {
      const transformedValue = readFns[field.type](value, field, config);
      if (transformedValue !== undefined) value = transformedValue;
    }
    setByPath(output, fieldPath, value);
  });

  return output;
};

const setByPath = (target: Record<string, any>, path: string, value: any) => {
  if (!path) return;
  const segments = path.split(".");
  let cursor: Record<string, any> = target;

  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    if (cursor[key] == null || typeof cursor[key] !== "object" || Array.isArray(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }

  cursor[segments[segments.length - 1]] = value;
};

/* ==========================================
   4. ENTRIES ENDPOINT (GET)
   ========================================== */
router.get("/api/:owner/:repo/:branch/entries/:path(*)", requireAuth, async (req: any, res: Response) => {
  try {
    const { owner, repo, branch, path: rawPath } = req.params;
    const { token } = await getToken(req.user, owner, repo);
    if (!token) throw createHttpError("Token not found", 401);

    const name = req.query.name as string;
    const metaOnly = req.query.meta === "true" || req.query.meta === "1";

    const normalizedPath = normalizePath(rawPath);
    if (normalizedPath === ".pages.yml") {
      assertGithubIdentity(req.user, "Only GitHub users can access settings.");
    }

    if (!name && normalizedPath !== ".pages.yml") {
      throw createHttpError("If no content entry name is provided, the path must be \".pages.yml\".", 400);
    }

    if (!name && normalizedPath === ".pages.yml" && metaOnly) {
      const cachedConfig = await getConfig(owner, repo, branch, {
        getToken: async () => token,
      });
      return res.json({
        status: "success",
        data: {
          sha: cachedConfig?.sha ?? null,
          version: cachedConfig?.version ?? null,
          lastCheckedAt: cachedConfig?.lastCheckedAt ?? null,
        },
      });
    }

    let config;
    let schema;

    if (name) {
      config = await getConfig(owner, repo, branch, {
        getToken: async () => token,
      });
      if (!config) throw createHttpError(`Configuration not found for ${owner}/${repo}/${branch}.`, 404);

      schema = getSchemaByName(config.object, name);
      if (!schema) throw createHttpError(`Schema not found for ${name}.`, 404);

      if (!normalizedPath.startsWith(schema.path)) throw createHttpError(`Invalid path "${rawPath}" for ${schema.type} "${name}".`, 400);

      const extension = schema.extension ?? "";
      if (getFileExtension(normalizedPath) !== extension) {
        throw createHttpError(`Invalid extension "${getFileExtension(normalizedPath)}" for ${schema.type} "${name}".`, 400);
      }
    } else {
      config = {};
    }

    const octokit = createOctokitInstance(token);
    let response;
    try {
      response = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: normalizedPath,
        ref: branch
      });
    } catch (error: any) {
      if (error?.status === 404) {
        throw createHttpError("Not found", 404);
      }
      throw error;
    }

    if (Array.isArray(response.data)) {
      throw createHttpError("Expected a file but found a directory", 400);
    } else if (response.data.type !== "file") {
      throw createHttpError("Invalid response type", 500);
    }

    const content = Buffer.from(response.data.content, "base64").toString();
    const contentObject = name
      ? parseContent(content, schema, config)
      : { body: content };

    res.json({
      status: "success",
      data: {
        sha: response.data.sha,
        name: response.data.name,
        path: response.data.path,
        contentObject
      }
    });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

const parseContent = (content: string, schema: Record<string, any>, config: Record<string, any>) => {
  const serializedTypes = ["yaml-frontmatter", "json-frontmatter", "toml-frontmatter", "yaml", "json", "toml"];
  let contentObject: Record<string, any> = {};

  if (serializedTypes.includes(schema && schema.format) && schema.fields && schema.fields.length > 0) {
    try {
      contentObject = parse(content, { format: schema.format, delimiters: schema.delimiters });
      let entryFields;
      if (schema.list) {
        contentObject = { listWrapper: contentObject };
        entryFields = [{
          name: "listWrapper",
          type: "object",
          list: true,
          fields: schema.fields
        }];
      } else {
        entryFields = schema.fields;
      }

      contentObject = deepMap(
        contentObject,
        entryFields,
        (value: any, field: any) => {
          const type = field.type;
          if (typeof type === 'string' && readFns[type]) {
            return readFns[type](value, field, config);
          }
          return value;
        }
      );
      if (schema.list) contentObject = contentObject.listWrapper;
    } catch (error: any) {
      throw createHttpError(`Error parsing frontmatter: ${error.message}`, 400);
    }
  } else {
    contentObject = { body: content };
  }
  return contentObject;
};

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

/* ==========================================
   7. BRANCHES POST ENDPOINT
   ========================================== */
router.post("/api/:owner/:repo/:branch/branches", requireAuth, async (req: any, res: Response) => {
  try {
    const { owner, repo, branch } = req.params;
    const { token } = await getToken(req.user, owner, repo, true);
    if (!token) throw createHttpError("Token not found", 401);

    const { name } = req.body;
    if (!name) throw createHttpError(`"name" is required.`, 400);

    const octokit = createOctokitInstance(token);
    const { data: refData } = await octokit.rest.git.getRef({
      owner, repo, ref: `heads/${branch}`,
    });
    const sha = refData.object.sha;

    const response = await octokit.rest.git.createRef({
      owner, repo, ref: `refs/heads/${name}`, sha,
    });

    res.json({
      status: "success",
      message: `Branch "${name}" created successfully from "${branch}".`,
      data: response.data,
    });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

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

/* ==========================================
   9. COLLABORATOR MANAGEMENT ENDPOINTS
   ========================================== */
router.get("/api/collaborators/:owner/:repo", requireAuth, async (req: any, res: Response) => {
  try {
    const { owner, repo } = req.params;
    const { repoAccess } = await requireGithubRepoWriteAccess(req.user, owner, repo, "Only GitHub users can manage collaborators.");

    const collaborators = await db.query.collaboratorTable.findMany({
      where: and(
        eq(collaboratorTable.ownerId, repoAccess.ownerId),
        eq(collaboratorTable.repoId, repoAccess.repoId)
      )
    });

    res.json({ status: "success", data: collaborators });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

router.post("/api/collaborators", requireAuth, async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) throw new Error("You must be signed in with GitHub to invite collaborators.");

    const { owner, repo, emails: rawEmails } = req.body;
    if (!owner || !repo || !rawEmails) throw new Error("Owner, repo, and emails are required.");

    const emails = Array.isArray(rawEmails) ? rawEmails : [rawEmails];

    // Authorization Check
    const { repoAccess, installation } = await assertRepoInInstallation(user, owner, repo);

    const baseUrl = getBaseUrl();
    const repoUrl = new URL(`/${owner}/${repo}`, baseUrl).toString();
    const createdCollaborators: any[] = [];
    const errors: string[] = [];
    let immediateAccessCount = 0;
    let pendingInviteCount = 0;

    for (const email of emails) {
      const normalizedEmail = normalizeEmail(email);
      const existingUser = await findVerifiedUserByEmail(normalizedEmail);
      const collaborator = await db.query.collaboratorTable.findFirst({
        where: and(
          eq(collaboratorTable.ownerId, repoAccess.ownerId),
          eq(collaboratorTable.repoId, repoAccess.repoId),
          sql`lower(${collaboratorTable.email}) = lower(${normalizedEmail})`
        ),
      });

      if (collaborator) {
        if (existingUser && collaborator.userId !== existingUser.id) {
          const updated = await db.update(collaboratorTable)
            .set({ userId: existingUser.id })
            .where(eq(collaboratorTable.id, collaborator.id))
            .returning();
          if (updated.length > 0) {
            createdCollaborators.push(...updated);
            immediateAccessCount += 1;
          }
        }
        errors.push(`${normalizedEmail} is already invited.`);
        continue;
      }

      if (!existingUser) {
        const inviteUrl = await createCollaboratorInviteUrl({ email: normalizedEmail, owner, repo, baseUrl });
        try {
          const html = `
            <div style="font-family: sans-serif; padding: 20px;">
              <h2>Join "${owner}/${repo}" on Pages CMS</h2>
              <p>You have been invited by <strong>${user.name || user.githubUsername || user.email}</strong> to collaborate on the repository <strong>${owner}/${repo}</strong>.</p>
              <p>Click the link below to accept the invitation:</p>
              <p><a href="${inviteUrl}" style="background-color: #0070f3; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Accept Invitation</a></p>
            </div>
          `;
          await sendEmail({ to: normalizedEmail, subject: `Join "${owner}/${repo}" on Pages CMS`, html });
        } catch (error: any) {
          errors.push(`${normalizedEmail}: ${error.message}`);
          continue;
        }
      } else {
        try {
          const html = `
            <div style="font-family: sans-serif; padding: 20px;">
              <h2>You were added to "${owner}/${repo}" on Pages CMS</h2>
              <p>You have been added by <strong>${user.name || user.githubUsername || user.email}</strong> as a collaborator on the repository <strong>${owner}/${repo}</strong>.</p>
              <p><a href="${repoUrl}">Go to Repository</a></p>
            </div>
          `;
          await sendEmail({ to: normalizedEmail, subject: `You were added to "${owner}/${repo}" on Pages CMS`, html });
        } catch (error: any) {
          errors.push(`${normalizedEmail}: ${error.message}`);
        }
      }

      const inserted = await db.insert(collaboratorTable).values({
        type: repoAccess.ownerType,
        installationId: installation.id,
        ownerId: repoAccess.ownerId,
        repoId: repoAccess.repoId,
        owner: repoAccess.ownerLogin,
        repo: repoAccess.repoName,
        email: normalizedEmail,
        userId: existingUser?.id ?? null,
        invitedBy: user.id
      }).returning();

      if (inserted.length > 0) {
        createdCollaborators.push(...inserted);
        if (existingUser) immediateAccessCount += 1;
        else pendingInviteCount += 1;
      }
    }

    if (createdCollaborators.length === 0) {
      throw new Error(errors.join(" "));
    }

    res.json({
      status: "success",
      message: immediateAccessCount > 0 && pendingInviteCount > 0
        ? `${immediateAccessCount} collaborator(s) added and ${pendingInviteCount} invite(s) sent.`
        : immediateAccessCount > 0
          ? `${immediateAccessCount} collaborator(s) added.`
          : `Invite sent.`,
      data: createdCollaborators,
      errors
    });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

router.delete("/api/collaborators/:id", requireAuth, async (req: any, res: Response) => {
  try {
    const collaboratorId = Number(req.params.id);
    const { owner, repo } = req.body; // passes owner/repo context in request body
    const user = req.user;

    const collaborator = await db.query.collaboratorTable.findFirst({ where: eq(collaboratorTable.id, collaboratorId) });
    if (!collaborator) throw new Error("Collaborator not found");

    const { repoAccess } = await assertRepoInInstallation(user, owner, repo);
    const deleted = await db.delete(collaboratorTable).where(
      and(eq(collaboratorTable.id, collaboratorId), eq(collaboratorTable.repoId, repoAccess.repoId))
    ).returning();

    if (!deleted || deleted.length === 0) throw new Error("Failed to delete collaborator");

    await db.delete(collaboratorInviteTable).where(and(
      sql`lower(${collaboratorInviteTable.email}) = lower(${collaborator.email})`,
      sql`lower(${collaboratorInviteTable.owner}) = lower(${owner})`,
      sql`lower(${collaboratorInviteTable.repo}) = lower(${repo})`,
    ));

    res.json({ status: "success", message: `Collaborator successfully removed.` });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

router.post("/api/collaborators/resend-invite", requireAuth, async (req: any, res: Response) => {
  try {
    const { id: collaboratorId, owner, repo } = req.body;
    const user = req.user;

    await assertRepoInInstallation(user, owner, repo);
    const collaborator = await db.query.collaboratorTable.findFirst({ where: eq(collaboratorTable.id, collaboratorId) });
    if (!collaborator) throw new Error("Collaborator not found");

    const baseUrl = getBaseUrl();
    const inviteUrl = await createCollaboratorInviteUrl({ email: collaborator.email, owner, repo, baseUrl });

    const html = `
      <div style="font-family: sans-serif; padding: 20px;">
        <h2>Join "${owner}/${repo}" on Pages CMS</h2>
        <p>You have been invited by <strong>${user.name || user.githubUsername || user.email}</strong> to collaborate on the repository <strong>${owner}/${repo}</strong>.</p>
        <p><a href="${inviteUrl}">Accept Invitation</a></p>
      </div>
    `;
    await sendEmail({ to: collaborator.email, subject: `Join "${owner}/${repo}" on Pages CMS`, html });

    res.json({ status: "success", message: `Invitation email resent to ${collaborator.email}.` });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

// Helper functions for Collaborators
const assertRepoInInstallation = async (user: any, owner: string, repo: string) => {
  const { token, repoAccess } = await requireGithubRepoWriteAccess(user, owner, repo);
  const installations = await getInstallations(token, [owner]);
  if (installations.length !== 1) throw new Error(`"${owner}" is not part of GitHub App installations.`);
  const installationRepos = await getInstallationRepos(token, installations[0].id);
  const isInstalledForRepo = installationRepos.some((installationRepo) =>
    installationRepo.id === repoAccess.repoId ||
    (installationRepo.owner?.login?.toLowerCase() === owner.toLowerCase() && installationRepo.name?.toLowerCase() === repo.toLowerCase())
  );
  if (!isInstalledForRepo) throw new Error(`"${owner}/${repo}" is not part of your installation.`);
  return { repoAccess, installation: installations[0] };
};

const generateInviteToken = () => {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(32);
  let token = "";
  for (let i = 0; i < 32; i += 1) {
    token += alphabet[bytes[i] % alphabet.length];
  }
  return token;
};

const createCollaboratorInviteUrl = async ({ email, owner, repo, baseUrl }: any) => {
  const token = generateInviteToken();
  const expiresAt = new Date(Date.now() + ((Number(process.env.COLLABORATOR_INVITE_LINK_EXPIRES_IN) || 86400) * 1000));

  await db.delete(collaboratorInviteTable).where(and(
    sql`lower(${collaboratorInviteTable.email}) = lower(${email})`,
    sql`lower(${collaboratorInviteTable.owner}) = lower(${owner})`,
    sql`lower(${collaboratorInviteTable.repo}) = lower(${repo})`,
  ));

  await db.insert(collaboratorInviteTable).values({ token, email, owner, repo, expiresAt });
  const inviteUrl = new URL("/sign-in/collaborator", baseUrl);
  inviteUrl.searchParams.set("token", token);
  return inviteUrl.toString();
};

/* ==========================================
   10. COLLABORATOR INVITES ENDPOINTS
   ========================================== */
router.get("/api/collaborator-invites/:token", async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const invite = await getInvite(token);
    if (!invite) return res.json({ status: "unavailable" });

    // Since Better Auth session exists on req.user, we can verify auth
    const user = (req as any).user;
    const destinationPath = `/${invite.owner}/${invite.repo}`;

    if (!user) {
      return res.json({
        status: "otp_required",
        email: invite.email,
        maskedEmail: maskEmail(invite.email),
        destinationPath,
      });
    }

    const claimed = await claimInvite(invite, user);
    if (!claimed) return res.json({ status: "wrong_account" });

    res.json({ status: "ready", destinationPath });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

router.post("/api/collaborator-invites/:token/accept", async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const invite = await getInvite(token);
    if (!invite) return res.status(404).json({ status: "unavailable" });

    const user = (req as any).user;
    if (!user) return res.status(401).json({ status: "unavailable" });

    const claimed = await claimInvite(invite, user);
    if (!claimed) return res.status(403).json({ status: "wrong_account" });

    res.json({ status: "ready", destinationPath: `/${invite.owner}/${invite.repo}` });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

// Helper functions for Invites
const getInvite = async (token: string) => {
  const invite = await db.query.collaboratorInviteTable.findFirst({ where: eq(collaboratorInviteTable.token, token) });
  if (!invite) return null;

  if (invite.expiresAt <= new Date()) {
    await db.delete(collaboratorInviteTable).where(eq(collaboratorInviteTable.id, invite.id));
    return null;
  }

  const collaborator = await db.query.collaboratorTable.findFirst({
    where: and(
      sql`lower(${collaboratorTable.email}) = lower(${invite.email})`,
      sql`lower(${collaboratorTable.owner}) = lower(${invite.owner})`,
      sql`lower(${collaboratorTable.repo}) = lower(${invite.repo})`,
    ),
  });

  if (!collaborator) {
    await db.delete(collaboratorInviteTable).where(eq(collaboratorInviteTable.id, invite.id));
    return null;
  }
  return invite;
};

const maskEmail = (email: string) => {
  const [name, domain] = email.split("@");
  if (!name || !domain) return email;
  const visible = name.slice(0, Math.min(2, name.length));
  return `${visible}${"*".repeat(Math.max(1, name.length - visible.length))}@${domain}`;
};

const claimInvite = async (invite: any, user: { id: string; email: string }) => {
  if (normalizeEmail(user.email) !== normalizeEmail(invite.email)) return false;

  await db.update(collaboratorTable).set({ userId: user.id })
    .where(and(
      sql`lower(${collaboratorTable.email}) = lower(${invite.email})`,
      sql`lower(${collaboratorTable.owner}) = lower(${invite.owner})`,
      sql`lower(${collaboratorTable.repo}) = lower(${invite.repo})`,
    ));

  await db.delete(collaboratorInviteTable).where(eq(collaboratorInviteTable.id, invite.id));
  return true;
};

/* ==========================================
   11. GITHUB WEBHOOK ENDPOINT
   ========================================== */
router.post("/api/webhook/github", async (req: Request, res: Response) => {
  try {
    const signature = req.headers["x-hub-signature-256"] as string;
    const event = req.headers["x-github-event"] as string;

    // Access the raw body captured by express.json verification
    const bodyStr = (req as any).rawBody ? (req as any).rawBody.toString("utf8") : "";

    const secret = process.env.GITHUB_APP_WEBHOOK_SECRET;
    if (!secret) {
      console.error("Missing GITHUB_APP_WEBHOOK_SECRET");
      return res.status(500).json(null);
    }

    const hmac = crypto.createHmac("sha256", secret);
    const digest = `sha256=${hmac.update(bodyStr).digest("hex")}`;
    if (!signature) return res.status(401).json(null);

    const signatureBuffer = Buffer.from(signature, "utf8");
    const digestBuffer = Buffer.from(digest, "utf8");
    if (signatureBuffer.length !== digestBuffer.length || !crypto.timingSafeEqual(signatureBuffer, digestBuffer)) {
      return res.status(401).json(null);
    }

    const data = JSON.parse(bodyStr);

    // Send HTTP response immediately
    res.sendStatus(200);

    // Run processing asynchronously after returning HTTP success to GitHub
    (async () => {
      try {
        if (await handleInstallationWebhookEvent(event, data)) return;
        if (await handlePushWebhookEvent(event, data)) return;
        if (await handleActionWebhookEvent(event, data)) return;
      } catch (error) {
        console.error("Error in Webhook event processing", { error, event, action: data?.action });
      }
    })();
  } catch (error) {
    console.error("Error processing webhook request:", error);
    res.sendStatus(500);
  }
});

export { router };
