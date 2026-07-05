/**
 * Helper functions for the schema defined in .pages.yml
 */

import slugify from "slugify";
import { defaultValues, schemas } from "../fields/registry.ts";
import { z } from "zod";
import { Field } from "../types/field.ts";
import { format } from "date-fns";

type SchemaGroupTrailItem = {
  name: string;
  label?: string;
};

type NavigationNode = {
  type: "group" | "file" | "collection" | "media";
  name: string;
  label?: string;
  items?: NavigationNode[];
};

// Deep map a content object to a schema
const deepMap = (
  contentObject: Record<string, any>,
  fields: Field[],
  apply: (value: any, field: Field) => any
): Record<string, any> => {
  const traverse = (data: any, schema: Field[]): any => {
    const result: any = {};
    const currentData = data || {}; // Ensure data is an object

    schema.forEach(field => {
      const value = currentData[field.name];

      if (field.list) {
        if (value === undefined) {
          result[field.name] = apply(value, field);
        } else {
          result[field.name] = Array.isArray(value)
            ? value.map(item => {
                if (field.type === "object") {
                  return traverse(item, field.fields || []);
                } else if (field.type === "block") {
                  const blockKey = field.blockKey || "_block";
                  const blockName = item?.[blockKey];
                  const blockDef = field.blocks?.find(b => b.name === blockName);
                  if (blockDef) {
                     const innerResult = traverse(item, blockDef.fields || []);
                     return { [blockKey]: blockName, ...innerResult }; 
                  }
                  return item;
                } else {
                  return apply(item, field);
                }
              })
            : [];
        }
      } else if (field.type === "object") {
        result[field.name] = traverse(value, field.fields || []);
      } else if (field.type === "block") {
        const blockKey = field.blockKey || "_block";
        const blockName = value?.[blockKey];
        const blockDef = field.blocks?.find(b => b.name === blockName);
        if (blockDef && value) {
          const innerResult = traverse(value, blockDef.fields || []);
          result[field.name] = { [blockKey]: blockName, ...innerResult };
        } else {
          result[field.name] = value;
        }
      } else {
        result[field.name] = apply(value, field);
      }
    });
    
    return result;
  };

  return traverse(contentObject, fields);
};

// Create an initial state for an entry based on the schema fields and content
const initializeState = (
  fields: Field[] | undefined,
  contentObject: Record<string, any> = {}
): Record<string, any> => {
  if (!fields) return {};
  const sanitizedContent = contentObject || {};

  return deepMap(sanitizedContent, fields, (value, field) => {
    let appliedValue = value;
    if (value === undefined) {
      appliedValue = field.list
        ? (typeof field.list === "object" && field.list.default !== undefined)
          ? field.list.default
          : []
        : getDefaultValue(field);
    }
    else if (appliedValue === null && field.type !== 'object' && !field.list) {
       appliedValue = getDefaultValue(field);
    }
    return appliedValue;
  });
};

// Get the default value for a field
const getDefaultValue = (field: Record<string, any>) => {
  if (field.default !== undefined) {
    return field.default;
  } else if (field.type === "object") {
    return initializeState(field.fields, {});
  } else if (field.type === "block") {
    return null;
  } else {
    const defaultValue = defaultValues?.[field.type];
    return defaultValue instanceof Function
      ? defaultValue(field)
      : defaultValue !== undefined ? defaultValue : "";
  }
};

// Treat optional object fields as absent when all nested values are empty.
const isEffectivelyEmpty = (value: unknown): boolean => {
  if (value == null || value === "") return true;

  if (Array.isArray(value)) {
    return value.length === 0 || value.every((item) => isEffectivelyEmpty(item));
  }

  if (value instanceof Date) return false;

  if (typeof value === "object") {
    const entries = Object.values(value as Record<string, unknown>);
    return entries.length === 0 || entries.every((item) => isEffectivelyEmpty(item));
  }

  return false;
};

// Generate a Zod schema for validation
const generateZodSchema = (
  fields: Field[],
  ignoreHidden: boolean = false
): z.ZodTypeAny => {
  const buildSchemaObject = (currentFields: Field[]): Record<string, z.ZodTypeAny> => {
    return currentFields.reduce((acc: Record<string, z.ZodTypeAny>, field) => {
      if (ignoreHidden && field.hidden) return acc;

      let fieldSchema: z.ZodTypeAny;

      if (field.type === 'object') {
        const objectSchema = z.object(buildSchemaObject(field.fields || []));
        fieldSchema = field.required
          ? objectSchema
          : z.preprocess(
              (value) => (isEffectivelyEmpty(value) ? undefined : value),
              objectSchema.optional()
            );
      } else if (field.type === 'block') {
        if (!field.blocks || field.blocks.length === 0) {
          fieldSchema = z.object({}).passthrough();
        } else {
          const discriminator = field.blockKey || "_block";
          const blockTypeSchemas = field.blocks.map(blockDef => {
            if (!blockDef.name) return null;
            const base = z.object({ [discriminator]: z.literal(blockDef.name) });
            const blockFieldsSchema = z.object(buildSchemaObject(blockDef.fields || []));
            return base.merge(blockFieldsSchema); 
          }).filter(schema => schema !== null) as z.ZodObject<any>[];

          if (blockTypeSchemas.length === 0) {
            fieldSchema = z.object({}).passthrough();
          } else if (blockTypeSchemas.length === 1) {
            fieldSchema = blockTypeSchemas[0].optional().nullable();
          } else {
            fieldSchema = z.discriminatedUnion(
              discriminator,
              blockTypeSchemas as [z.ZodObject<any>, z.ZodObject<any>, ...z.ZodObject<any>[]]
            ).optional().nullable();
          }
        }
      } else if (field.type && schemas[field.type]) {
        const fieldSchemaFn = schemas[field.type];
        fieldSchema = fieldSchemaFn(field);
      } else {
        const fallbackSchema = schemas["text"];
        fieldSchema = fallbackSchema ? fallbackSchema(field) : z.string();
      }

      if (field.list) {
        let arraySchema = z.array(fieldSchema);
        if (typeof field.list === "object") {
          if (field.list.min && typeof field.list.min === "number" && field.list.min > 0) {
            arraySchema = arraySchema.min(field.list.min);
          }
          if (field.list.max && typeof field.list.max === "number" && field.list.max > 0) {
            arraySchema = arraySchema.max(field.list.max);
          }
        }
        if (field.required) {
          arraySchema = arraySchema.min(1, { message: `Field requires at least one item.` });
          fieldSchema = arraySchema;
        } else {
          fieldSchema = arraySchema.optional();
        }
      }
      
      if (!field.list) {
        if (!field.required) {
          fieldSchema = fieldSchema.optional();
        } else {
          if (field.type === 'block') {
            fieldSchema = fieldSchema.refine(
              (val) => val != null && typeof val === 'object' && Object.keys(val).length > 0,
              { message: "Please select a block." }
            );
          }
        }
      }

      acc[field.name] = fieldSchema;
      return acc;
    }, {});
  };

  return z.object(buildSchemaObject(fields));
};

// Traverse the object and remove all empty/null/undefined values
const sanitizeObject = (object: any): any => {
  const isEmpty = (val: any) => val == null || val === "";

  if (Array.isArray(object)) {
    return object
      .map(val => (val && typeof val === "object" && !(val instanceof Date) ? sanitizeObject(val) : val))
      .filter(val => !isEmpty(val));
  }

  if (object && typeof object === "object" && !(object instanceof Date)) {
    const objectCopy = { ...object };

    Object.keys(objectCopy).forEach((key) => {
      const val = objectCopy[key];

      if (val && typeof val === "object" && !(val instanceof Date)) {
        objectCopy[key] = sanitizeObject(val);
      }

      if (
        (Array.isArray(objectCopy[key]) && objectCopy[key].every(isEmpty))
        || (typeof objectCopy[key] === "object" && !Array.isArray(objectCopy[key]) && !(objectCopy[key] instanceof Date) && objectCopy[key] != null && !Object.keys(objectCopy[key]).length)
        || isEmpty(objectCopy[key])
      ) {
        delete objectCopy[key];
      }
    });

    return objectCopy;
  }

  return object;
};

const getSchemaGroupTrail = (
  config: Record<string, any> | null | undefined,
  name: string,
): SchemaGroupTrailItem[] => {
  const navigation = config?.navigation?.content as NavigationNode[] | undefined;
  if (!navigation?.length || !name) return [];

  const visit = (
    nodes: NavigationNode[],
    parents: SchemaGroupTrailItem[],
  ): SchemaGroupTrailItem[] | null => {
    for (const node of nodes) {
      if (node.type === "group") {
        const match = visit(node.items || [], [
          ...parents,
          { name: node.name, label: node.label || node.name },
        ]);
        if (match) return match;
        continue;
      }

      if (node.name === name) {
        return parents;
      }
    }

    return null;
  };

  return visit(navigation, []) || [];
};

// Retrieve the matching schema for a media or content entry
const getSchemaByName = (config: Record<string, any> | null | undefined, name: string, type: string = "content") => {
  if (
    !config
    || (type === "media" && !config.media)
    || (type === "content" && !config.content)
    || !name
  ) return null;
  
  const schema = (type === "media")
    ? config.media.find((item: Record<string, any>) => item.name === name)
    : config.content.find((item: Record<string, any>) => item.name === name);

  if (!schema) return null;

  const clonedSchema = JSON.parse(JSON.stringify(schema));
  if (type === "content") {
    clonedSchema.groupTrail = getSchemaGroupTrail(config, name);
  }
  return clonedSchema;
};

// Safely access nested properties in an object
function safeAccess(obj: Record<string, any>, path: string) {
  return path.split(".").reduce((acc, part) => {
    if (part.endsWith("]")) {
      const [arrayPath, index] = part.split("[");
      if (!acc || typeof acc !== "object") return undefined;
      const arrayValue = acc[arrayPath];
      if (!Array.isArray(arrayValue)) return undefined;
      const parsedIndex = parseInt(index.replace("]", ""), 10);
      if (Number.isNaN(parsedIndex)) return undefined;
      return arrayValue[parsedIndex];
    }
    return acc && acc[part];
  }, obj);
}

// Interpolate a string with a data object, with optional prefix fallback (e.g. "fields")
function interpolate(input: string, data: Record<string, any>, prefixFallback?: string): string {
  return input.replace(/(?<!\\)\{([^}]+)\}/g, (_, token) => {
    let value = safeAccess(data, token);
    if (value === undefined && prefixFallback) {
      value = safeAccess(data, `${prefixFallback}.${token}`);
    }
    return value !== undefined ? String(value) : '';
  }).replace(/\\([{}])/g, '$1');
}

// Get a field by its path
function getFieldByPath(schema: Field[], path: string): Field | undefined {
  const [first, ...rest] = path.split('.');
  const field = schema.find(f => f.name === first);
  
  return !field ? undefined
    : rest.length === 0 ? field
    : field.type === 'object' && field.fields ? getFieldByPath(field.fields, rest.join('.'))
    : undefined;
}

function findNestedFieldPath(
  fields: Field[] | undefined,
  matcher: (field: Field) => boolean,
  prefix?: string,
): string | undefined {
  if (!fields?.length) return undefined;

  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.name}` : field.name;

    if (matcher(field)) return path;

    if (field.type === "object" && field.fields) {
      const nestedMatch = findNestedFieldPath(field.fields, matcher, path);
      if (nestedMatch) return nestedMatch;
    }
  }

  return undefined;
}

// Get the primary field for a schema
const getPrimaryField = (schema: Record<string, any>) => {
  return schema?.view?.primary
    || findNestedFieldPath(schema?.fields, (field) => field.name === "title")
    || findNestedFieldPath(
      schema?.fields,
      (field) => !["object", "block"].includes(String(field.type)),
    );
};

// Generate a filename for an entry
const generateFilename = (
  pattern: string,
  schema: Record<string, any>,
  state: Record<string, any>
) => {
  const now = new Date();
  pattern = pattern.replace(/\{year\}/g, format(now, 'yyyy'))
    .replace(/\{month\}/g, format(now, 'MM'))
    .replace(/\{day\}/g, format(now, 'dd'))
    .replace(/\{hour\}/g, format(now, 'HH'))
    .replace(/\{minute\}/g, format(now, 'mm'))
    .replace(/\{second\}/g, format(now, 'ss'));

  const primaryField = getPrimaryField(schema);
  pattern = pattern
    .replace(/\{primary\}/g, primaryField ? `{fields.${primaryField}}` : "untitled")
    .replace(/\{slug\}/g, primaryField ? `{fields.${primaryField}}` : "untitled");
  
  return pattern.replace(/\{(?:fields\.)?([^}]+)\}/g, (_, fieldName) => {
    const value = safeAccess(state, fieldName);
    return value ? slugify(String(value), { lower: true, strict: true }) : "";
  });
};

// Extract a date from a filename when possible
function getDateFromFilename(filename: string) {
  const pattern = /^(\d{4})-(\d{2})-(\d{2})-/;
  const match = filename.match(pattern);

  if (match) {
    const [ , year, month, day ] = match;
    const date = new Date(`${year}-${month}-${day}`);
    if (!isNaN(date.getTime())) {
      return { year, month, day, string: `${year}-${month}-${day}` };
    }
  }

  return undefined;
}

export {
  deepMap,
  initializeState,
  getDefaultValue,
  sanitizeObject,
  getSchemaByName,
  getFieldByPath,
  getPrimaryField,
  generateFilename,
  getDateFromFilename,
  generateZodSchema,
  safeAccess,
  interpolate
};
