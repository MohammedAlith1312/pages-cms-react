import { Router, Response } from "express";
import { requireAuth } from "./shared";

import { getRepoReadContext } from "../lib/api-repo-context";
import { createHttpError, sendErrorResponse } from "../lib/api-error";
import { getConfig } from "../lib/config-store";
import { getToken } from "../lib/token";
import {
  getSchemaByName,
  deepMap,
  getDateFromFilename,
  getFieldByPath,
  safeAccess,
} from "../lib/schema";
import {
  normalizePath,
  getFileExtension,
} from "../lib/utils/file";
import {
  getCollectionCache,
} from "../lib/github-cache-file";
import { parse } from "../lib/serialization";
import { readFns } from "../fields/registry";
import { createOctokitInstance } from "../lib/utils/octokit";
import { assertGithubIdentity } from "../lib/authz-shared";

const router = Router();

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
  const serializedTypesLocal = ["yaml-frontmatter", "json-frontmatter", "toml-frontmatter", "yaml", "json", "toml"];
  const excludedFiles = schema.exclude || [];
  const extension = schema.extension ?? "";

  let parsedContents: Record<string, any>[] = [];
  let parsedErrors: string[] = [];

  parsedContents = contents.map((item: any) => {
    if (item.type === "file" && (extension === "" || item.path.endsWith(`.${extension}`)) && !excludedFiles.includes(item.name)) {
      let contentObject: Record<string, any> = {};

      if (serializedTypesLocal.includes(schema.format) && schema.fields) {
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
  const serializedTypesLocal = ["yaml-frontmatter", "json-frontmatter", "toml-frontmatter", "yaml", "json", "toml"];
  let contentObject: Record<string, any> = {};

  if (serializedTypesLocal.includes(schema && schema.format) && schema.fields && schema.fields.length > 0) {
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

export { router };
