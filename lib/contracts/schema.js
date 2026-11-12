// Zero-dependency schema primitives for AgentXRay's contract layer.
//
// Why not zod: `npm install` is not usable in this environment (EPERM on the npm
// cache), so the contract layer ships its own ~150-line validator. It is
// deliberately small: only the primitives the sessions/context surface needs.
//
// Every schema has:
//   .parse(value)          validate → normalized value, or throw ContractError
//                          (message embeds a JSON path such as `$.sessions[0].id`)
//   .toJSON(asRoot?)       machine-readable meta description used by
//                          scripts/gen-api-types.mjs to emit TypeScript types
//   .optional              true for `optional(...)`, so object fields know
//                          whether the key may be absent
//
// `named(name, schema)` tags a schema so nested references serialize as
// `{ kind: 'ref', name }`; the generator emits one TS declaration per name and
// refers back by name instead of inlining everything.

class ContractError extends Error {
  constructor(message, path = '$') {
    super(`${path}: ${message}`);
    this.name = 'ContractError';
    this.path = path;
  }
}

function fail(path, message) {
  throw new ContractError(message, path);
}

function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function childPath(path, key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function create(kind, parseValue, describeMeta, extra = {}) {
  const schema = { kind, ...extra };
  schema.parse = (value, path = '$') => parseValue(value, path);
  schema.toJSON = (asRoot = false) => {
    if (!asRoot && schema.defName) return { kind: 'ref', name: schema.defName };
    return describeMeta();
  };
  return schema;
}

function string(opts = {}) {
  return create(
    'string',
    (value, path) => {
      if (typeof value !== 'string') fail(path, `expected string, got ${describeValue(value)}`);
      if (opts.minLength !== undefined && value.length < opts.minLength) {
        fail(path, `must be at least ${opts.minLength} chars`);
      }
      if (opts.maxLength !== undefined && value.length > opts.maxLength) {
        fail(path, `must be at most ${opts.maxLength} chars`);
      }
      if (opts.pattern && !opts.pattern.test(value)) fail(path, `must match ${opts.pattern}`);
      return value;
    },
    () => ({ kind: 'string' })
  );
}

function number(opts = {}) {
  return create(
    'number',
    (value, path) => {
      let parsed = value;
      if (opts.from === 'query') {
        // Query strings are text: only a plain non-negative integer is accepted,
        // so `?limit=abc`, `?limit=1.5`, `?limit=` and `?limit=-1` all fail
        // instead of being silently coerced (`Number('') === 0` etc.).
        if (typeof value !== 'string' || !/^\d+$/.test(value)) {
          fail(path, `expected a non-negative integer, got ${JSON.stringify(value)}`);
        }
        parsed = Number(value);
      } else if (typeof value !== 'number') {
        fail(path, `expected number, got ${describeValue(value)}`);
      }
      if (!Number.isFinite(parsed)) fail(path, 'expected a finite number');
      if (opts.integer && !Number.isInteger(parsed)) fail(path, 'expected an integer');
      if (opts.min !== undefined && parsed < opts.min) fail(path, `must be >= ${opts.min}`);
      if (opts.max !== undefined && parsed > opts.max) fail(path, `must be <= ${opts.max}`);
      return parsed;
    },
    () => ({ kind: 'number', ...(opts.integer ? { integer: true } : {}) })
  );
}

function boolean(opts = {}) {
  return create(
    'boolean',
    (value, path) => {
      if (opts.from === 'query') {
        if (value === '1' || value === 'true') return true;
        if (value === '0' || value === 'false') return false;
        fail(path, `expected boolean flag (1/0/true/false), got ${JSON.stringify(value)}`);
      }
      if (typeof value !== 'boolean') fail(path, `expected boolean, got ${describeValue(value)}`);
      return value;
    },
    () => ({ kind: 'boolean' })
  );
}

function literal(expected) {
  return create(
    'literal',
    (value, path) => {
      if (value !== expected) fail(path, `expected ${JSON.stringify(expected)}, got ${describeValue(value)}`);
      return value;
    },
    () => ({ kind: 'literal', value: expected })
  );
}

function nullable(inner) {
  return create(
    'nullable',
    (value, path) => (value === null ? null : inner.parse(value, path)),
    () => ({ kind: 'nullable', of: inner.toJSON() }),
    { inner }
  );
}

function optional(inner) {
  return create(
    'optional',
    (value, path) => (value === undefined ? undefined : inner.parse(value, path)),
    () => inner.toJSON(),
    { optional: true, inner }
  );
}

function array(item) {
  return create(
    'array',
    (value, path) => {
      if (!Array.isArray(value)) fail(path, `expected array, got ${describeValue(value)}`);
      return value.map((entry, index) => item.parse(entry, `${path}[${index}]`));
    },
    () => ({ kind: 'array', of: item.toJSON() })
  );
}

function record(valueSchema) {
  return create(
    'record',
    (value, path) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        fail(path, `expected object, got ${describeValue(value)}`);
      }
      const out = {};
      for (const key of Object.keys(value)) out[key] = valueSchema.parse(value[key], childPath(path, key));
      return out;
    },
    () => ({ kind: 'record', of: valueSchema.toJSON() })
  );
}

function object(shape, opts = {}) {
  const fields = Object.entries(shape).map(([name, schema]) => ({
    name,
    schema,
    required: !schema.optional,
  }));
  const known = new Set(fields.map((field) => field.name));
  return create(
    'object',
    (value, path) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        fail(path, `expected object, got ${describeValue(value)}`);
      }
      const out = {};
      for (const field of fields) {
        const raw = value[field.name];
        if (raw === undefined) {
          if (field.required) fail(childPath(path, field.name), 'is required');
          continue;
        }
        out[field.name] = field.schema.parse(raw, childPath(path, field.name));
      }
      // Additive server fields must never break the contract: unknown keys are
      // preserved as-is unless the schema is explicitly closed.
      if (opts.open !== false) {
        for (const key of Object.keys(value)) if (!known.has(key)) out[key] = value[key];
      }
      return out;
    },
    () => ({
      kind: 'object',
      fields: fields.map((field) => ({ name: field.name, optional: !field.required, schema: field.schema.toJSON() })),
      open: opts.open !== false,
    })
  );
}

function union(...variants) {
  return create(
    'union',
    (value, path) => {
      const errors = [];
      for (const variant of variants) {
        try {
          return variant.parse(value, path);
        } catch (error) {
          errors.push(error.message);
        }
      }
      const labels = variants.map((variant) => label(variant.toJSON())).join(' | ');
      fail(path, `expected ${labels}, got ${describeValue(value)}`);
    },
    () => ({ kind: 'union', variants: variants.map((variant) => variant.toJSON()) })
  );
}

// Human/TS-ish label for a schema meta description (error messages only).
function label(meta) {
  switch (meta.kind) {
    case 'ref':
      return meta.name;
    case 'nullable':
      return `${label(meta.of)} | null`;
    case 'array':
      return `${label(meta.of)}[]`;
    case 'union':
      return meta.variants.map(label).join(' | ');
    case 'literal':
      return JSON.stringify(meta.value);
    case 'object':
    case 'record':
      return 'object';
    default:
      return meta.kind;
  }
}

function named(name, schema) {
  schema.defName = name;
  return schema;
}

module.exports = {
  ContractError,
  array,
  boolean,
  literal,
  named,
  nullable,
  number,
  object,
  optional,
  record,
  string,
  union,
};
