import { z, ZodIssueCode } from "zod";
import { Field } from "../types/field.ts";
import { swapPrefix } from "../lib/github-image.ts";
import { getSchemaByName } from "../lib/schema.ts";
import { getFileExtension, extensionCategories, normalizeMediaPath } from "../lib/utils/file.ts";

const getAllowedExtensions = (field: Field, mediaConfig: any): string[] | undefined => {
  const baseExtensions = [...(extensionCategories['image'] || [])];
  if (!mediaConfig) return baseExtensions;
  if (!field.options?.extensions && !field.options?.categories) return mediaConfig?.extensions || baseExtensions;

  let extensions = baseExtensions;

  if (field.options?.extensions && Array.isArray(field.options?.extensions)) {
    extensions = [...field.options?.extensions];
  } else if (Array.isArray(field.options?.categories)) {
    extensions = field.options?.categories.flatMap(
      (category: string) => extensionCategories[category] || []
    );
  } else if (mediaConfig?.extensions && Array.isArray(mediaConfig.extensions)) {
    extensions = [...mediaConfig.extensions];
  }

  if (extensions.length > 0 && mediaConfig?.extensions && Array.isArray(mediaConfig.extensions)) {
    extensions = extensions.filter(ext => mediaConfig.extensions.includes(ext));
  }

  return extensions;
};

const imageSchema = (field: Field, configObject?: Record<string, any>) => {
  const mediaConfig = configObject && (field.options?.media === false
    ? undefined
    : field.options?.media && typeof field.options.media === 'string'
      ? getSchemaByName(configObject, field.options.media, "media")
      : configObject.media?.[0]);
  const mediaInputPath = mediaConfig?.input;
  const allowedExtensions = getAllowedExtensions(field, mediaConfig);
  let zodSchema: z.ZodTypeAny;

  const isMultiple = !!field.options?.multiple;
  const enforceUnique = isMultiple && field.options?.unique === true;

  zodSchema = isMultiple
    ? z.array(z.string()).optional().nullable()
    : z.string().optional().nullable();

  zodSchema = zodSchema.superRefine((data, ctx) => {
    let isEmpty = false;
    let hasEmptyElementInArray = false;

    if (isMultiple) {
      isEmpty = data === null || data === undefined || data.length === 0;
      if (Array.isArray(data) && data.length > 0) {
        hasEmptyElementInArray = data.some(s => typeof s === 'string' && s === "");
      }
    } else {
      isEmpty = data === null || data === undefined || data === "";
    }

    if (field.required && isEmpty) {
      ctx.addIssue({
        code: ZodIssueCode.custom,
        message: "This field is required",
      });
    }

    if (isMultiple && hasEmptyElementInArray) {
      ctx.addIssue({
        code: ZodIssueCode.custom,
        message: "Image path cannot be empty within the list.",
      });
      return;
    }

    if (enforceUnique && Array.isArray(data)) {
      const normalizedPaths = data
        .filter((path): path is string => typeof path === "string" && path !== "")
        .map((path) => normalizeMediaPath(path));
      if (new Set(normalizedPaths).size !== normalizedPaths.length) {
        ctx.addIssue({
          code: ZodIssueCode.custom,
          message: "Image paths must be unique.",
        });
        return;
      }
    }

    if (isEmpty) return;

    const checkPath = (path: unknown) => {
      if (typeof path !== 'string' || path === "") return;
      if (mediaInputPath && !path.startsWith(mediaInputPath)) {
        ctx.addIssue({ code: ZodIssueCode.custom, message: `Path must start with the media directory: ${mediaInputPath}` });
      }
      const fileExtension = getFileExtension(path);
      if (allowedExtensions && allowedExtensions.length > 0) {
        if (!allowedExtensions.includes(fileExtension)) {
          ctx.addIssue({
            code: ZodIssueCode.custom,
            message: `Invalid file extension '.${fileExtension}'. Allowed: ${allowedExtensions.map((e: string) => `.${e}`).join(', ')}`
          });
        }
      }
    };

    if (isMultiple && Array.isArray(data)) {
      data.forEach(checkPath);
    } else if (!isMultiple && typeof data === 'string') {
      checkPath(data);
    }
  });

  return zodSchema;
};

const getFileAllowedExtensions = (field: Field, mediaConfig: any): string[] | undefined => {
  if (!mediaConfig) return undefined;
  if (!field.options?.extensions && !field.options?.categories) return mediaConfig?.extensions || undefined;

  let extensions: string[] = [];

  if (field.options?.extensions && Array.isArray(field.options?.extensions)) {
    extensions = [...field.options?.extensions];
  } else if (Array.isArray(field.options?.categories)) {
    extensions = field.options?.categories.flatMap(
      (category: string) => extensionCategories[category] || []
    );
  } else if (mediaConfig?.extensions && Array.isArray(mediaConfig.extensions)) {
    extensions = [...mediaConfig.extensions];
  }

  if (extensions.length > 0 && mediaConfig?.extensions && Array.isArray(mediaConfig.extensions)) {
    extensions = extensions.filter(ext => mediaConfig.extensions.includes(ext));
  }

  return extensions;
};

const fileSchema = (field: Field, configObject?: Record<string, any>) => {
  const mediaConfig = configObject && (field.options?.media === false
    ? undefined
    : field.options?.media && typeof field.options.media === 'string'
      ? getSchemaByName(configObject, field.options.media, "media")
      : configObject.media?.[0]);
  const mediaInputPath = mediaConfig?.input;
  const allowedExtensions = getFileAllowedExtensions(field, mediaConfig);
  let zodSchema: z.ZodTypeAny;

  const isMultiple = !!field.options?.multiple;
  const enforceUnique = isMultiple && field.options?.unique === true;

  zodSchema = isMultiple
    ? z.array(z.string()).optional().nullable()
    : z.string().optional().nullable();

  zodSchema = zodSchema.superRefine((data, ctx) => {
    let isEmpty = false;
    let hasEmptyElementInArray = false;

    if (isMultiple) {
      isEmpty = data === null || data === undefined || data.length === 0;
      if (Array.isArray(data) && data.length > 0) {
        hasEmptyElementInArray = data.some(s => typeof s === 'string' && s === "");
      }
    } else {
      isEmpty = data === null || data === undefined || data === "";
    }

    if (field.required && isEmpty) {
      ctx.addIssue({
        code: ZodIssueCode.custom,
        message: "This field is required",
      });
      return;
    }

    if (isMultiple && hasEmptyElementInArray) {
      ctx.addIssue({ code: ZodIssueCode.custom, message: "File path cannot be empty within the list." });
    }

    if (enforceUnique && Array.isArray(data)) {
      const normalizedPaths = data
        .filter((path): path is string => typeof path === "string" && path !== "")
        .map((path) => normalizeMediaPath(path));
      if (new Set(normalizedPaths).size !== normalizedPaths.length) {
        ctx.addIssue({
          code: ZodIssueCode.custom,
          message: "File paths must be unique.",
        });
        return;
      }
    }

    if (isEmpty) return;

    const checkPath = (path: unknown) => {
      if (typeof path !== 'string' || path === "") return;
      if (mediaInputPath && !path.startsWith(mediaInputPath)) {
        ctx.addIssue({ code: ZodIssueCode.custom, message: `Path must start with the media directory: ${mediaInputPath}` });
      }
      const fileExtension = getFileExtension(path);
      if (allowedExtensions && allowedExtensions.length > 0) {
        if (!allowedExtensions.includes(fileExtension)) {
          ctx.addIssue({
            code: ZodIssueCode.custom,
            message: `Invalid file extension '.${fileExtension}'. Allowed: ${allowedExtensions.map((e: string) => `.${e}`).join(', ')}`
          });
        }
      }
    };

    if (isMultiple && Array.isArray(data)) { data.forEach(checkPath); }
    else if (!isMultiple && typeof data === 'string') { checkPath(data); }
  });

  return zodSchema;
};

// Implement standard registry objects
const schemas: Record<string, (field: Field, configObject?: Record<string, any>) => z.ZodTypeAny> = {
  boolean: (field: Field) => z.coerce.boolean(),
  code: (field: Field) => z.string(),
  date: (field: Field) => z.string(),
  number: (field: Field) => z.coerce.number(),
  reference: (field: Field) => z.string(),
  "rich-text": (field: Field) => z.string(),
  select: (field: Field) => z.string(),
  string: (field: Field) => z.string(),
  text: (field: Field) => z.string(),
  uuid: (field: Field) => z.string(),
  image: imageSchema,
  file: fileSchema,
};

const defaultValues: Record<string, any> = {
  boolean: false,
  code: "",
  date: "",
  number: "",
  reference: "",
  "rich-text": "",
  select: "",
  string: "",
  text: "",
  uuid: "",
  image: (field: Field) => (field.options?.multiple ? [] : ""),
  file: (field: Field) => (field.options?.multiple ? [] : ""),
};

const imageRead = (value: any, field: Field, config?: Record<string, any>): string | string[] | null => {
  if (!value) return null;
  if (Array.isArray(value) && !value.length) return null;
  
  const mediaConfig = (config?.object?.media?.length && field.options?.media !== false)
    ? field.options?.media && typeof field.options.media === 'string'
      ? getSchemaByName(config.object, field.options.media, "media")
      : config.object.media[0]
    : undefined;

  if (!mediaConfig) return value;

  if (Array.isArray(value)) {
    return value.map(v => imageRead(v, field, config)) as string[];
  }

  const normalizedValue = normalizeMediaPath(String(value));
  return swapPrefix(normalizedValue, mediaConfig.output, mediaConfig.input, true);
};

const imageWrite = (value: any, field: Field, config?: Record<string, any>): string | string[] | null => {
  if (!value) return null;
  if (Array.isArray(value) && !value.length) return null;

  const mediaConfig = (config?.object?.media?.length && field.options?.media !== false)
    ? field.options?.media && typeof field.options.media === 'string'
      ? getSchemaByName(config.object, field.options.media, "media")
      : config.object.media[0]
    : undefined;

  if (!mediaConfig) return value;

  if (Array.isArray(value)) {
    return value.map(v => imageWrite(v, field, config)) as string[];
  }
  const normalizedValue = normalizeMediaPath(String(value));
  return swapPrefix(normalizedValue, mediaConfig.input, mediaConfig.output);
};

const readFns: Record<string, (value: any, field: Field, configObject?: Record<string, any>) => any> = {
  image: imageRead,
  file: imageRead, // behaves exactly identical to image read
};

const writeFns: Record<string, (value: any, field: Field, configObject?: Record<string, any>) => any> = {
  image: imageWrite,
  file: imageWrite, // behaves exactly identical to image write
};

const fieldTypes = new Set<string>(Object.keys(schemas));

export { schemas, readFns, writeFns, defaultValues, fieldTypes };
