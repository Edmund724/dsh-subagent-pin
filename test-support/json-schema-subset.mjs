/**
 * The raw JSON Schema subset `tools.register()` enforces before it stores a
 * definition, ported from `@deepseek-ai/dsh-tools/lib/index.js`
 * (`checkSchemaNode` / `assertSupportedJsonSchema`, 0.2.0-rc.2).
 *
 * Why a port and not the real checker: the registry's check lives in the app's
 * asar and is not importable from a profile-installed row, while the Host
 * double used to accept any schema at all — which is precisely how a definition
 * the real registry refuses shipped green. The steering row only ever hands in
 * two literal schemas, so the checker it must satisfy is worth carrying here.
 *
 * Ported: the keyword allowlist, `type` xor `oneOf`, the per-type keyword
 * applicability table, `required` as an array of declared property names,
 * boolean `additionalProperties`, nested `properties`/`items`, integer/enum/
 * const scalar rules, and the string `description`/`title` checks.
 *
 * Not ported (none of them reachable from this row's literals): the cross-realm
 * prototype checks, the `oneOf` sibling tail, the circular-schema guard, and
 * the lossless-JSON checks on annotation values.
 *
 * @module dsh-subagent-pin/test-support/json-schema-subset
 */

const CONSTRAINT_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
])

const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])

const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']

/** Keywords that are invalid beside `oneOf`, and their one allowed owner type. */
const ONE_OF_SIBLING_KEYWORDS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']

/** The one declared `type` each keyword may sit on. */
const KEYWORD_TYPES = {
  properties: ['object'],
  required: ['object'],
  additionalProperties: ['object'],
  items: ['array'],
  enum: ['string', 'number', 'integer', 'boolean', 'null'],
  const: ['string', 'number', 'integer', 'boolean', 'null'],
}

/**
 * Test for a plain JSON record.
 *
 * @param value - candidate from any JavaScript realm.
 * @returns whether the value is a non-array object.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a scalar is valid for one declared schema type.
 *
 * @param type - the declared `type`.
 * @param value - candidate scalar.
 * @returns whether the value matches that type.
 */
function scalarMatches(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
    case 'integer': return Number.isInteger(value) && !Object.is(value, -0)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return false
  }
}

/**
 * Collect every violation in one schema tree, in the same walk order as the
 * Host's checker so a test can pin the exact reason.
 *
 * @param node - schema node of unknown shape.
 * @param path - dotted path used in violation messages.
 * @param violations - accumulator.
 * @param seen - nodes on the current path, for the circular check.
 */
function walk(node, path, violations, seen) {
  if (!isRecord(node)) {
    violations.push(`${path} must be a schema object`)
    return
  }
  if (seen.has(node)) {
    violations.push(`${path} is circular`)
    return
  }
  seen.add(node)

  for (const key of Object.keys(node)) {
    if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue
    violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`)
  }
  if (Object.hasOwn(node, 'description') && typeof node.description !== 'string') {
    violations.push(`${path}.description must be a string`)
  }
  if (Object.hasOwn(node, 'title') && typeof node.title !== 'string') {
    violations.push(`${path}.title must be a string`)
  }

  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) {
    violations.push(`${path} cannot declare both type and oneOf`)
    seen.delete(node)
    return
  }
  if (!hasType && !hasOneOf) {
    for (const key of ONE_OF_SIBLING_KEYWORDS) {
      if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`)
    }
    seen.delete(node)
    return
  }

  if (hasOneOf) {
    for (const key of ONE_OF_SIBLING_KEYWORDS) {
      if (Object.hasOwn(node, key)) violations.push(`${path}.${key} is not supported beside oneOf`)
    }
    const oneOf = node.oneOf
    if (!Array.isArray(oneOf) || oneOf.length < 2) {
      violations.push(`${path}.oneOf must be an array of at least two schemas`)
    } else {
      oneOf.forEach((entry, index) => walk(entry, `${path}.oneOf[${index}]`, violations, seen))
    }
    seen.delete(node)
    return
  }

  const type = node.type
  if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
    violations.push(Array.isArray(type)
      ? `${path}.type must be a single type string (type arrays are not supported)`
      : `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`)
    seen.delete(node)
    return
  }

  for (const [key, types] of Object.entries(KEYWORD_TYPES)) {
    if (Object.hasOwn(node, key) && !types.includes(type)) {
      violations.push(`${path}.${key} is not supported on type "${type}"`)
    }
  }

  if (type === 'object') {
    if (Object.hasOwn(node, 'properties')) {
      if (!isRecord(node.properties)) violations.push(`${path}.properties must be an object of schemas`)
      else for (const [name, child] of Object.entries(node.properties)) walk(child, `${path}.properties.${name}`, violations, seen)
    }
    if (Object.hasOwn(node, 'required')) {
      const required = node.required
      if (!Array.isArray(required) || required.some((entry) => typeof entry !== 'string')) {
        violations.push(`${path}.required must be an array of strings`)
      } else {
        const declared = isRecord(node.properties) ? node.properties : {}
        for (const key of required) {
          if (!Object.hasOwn(declared, key)) violations.push(`${path}.required names "${key}" which is not in properties`)
        }
      }
    }
    if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
      violations.push(`${path}.additionalProperties must be a boolean`)
    }
  } else if (type === 'array') {
    if (Object.hasOwn(node, 'items')) walk(node.items, `${path}.items`, violations, seen)
  } else {
    if (Object.hasOwn(node, 'enum')) {
      const allowed = node.enum
      if (!Array.isArray(allowed) || allowed.length === 0 || allowed.some((entry) => !scalarMatches(type, entry))) {
        violations.push(`${path}.enum must be a non-empty array of ${type} values`)
      }
    }
    if (Object.hasOwn(node, 'const') && !scalarMatches(type, node.const)) {
      violations.push(`${path}.const must be a ${type} value`)
    }
  }

  seen.delete(node)
}

/**
 * Every reason one schema falls outside the subset `tools.register()` enforces.
 *
 * @param schema - candidate raw JSON Schema.
 * @returns violations in walk order; empty means the registry accepts it.
 */
export function violationsOf(schema) {
  const violations = []
  walk(schema, 'schema', violations, new Set())
  return violations
}

/**
 * Throw the way the registry does when a schema falls outside the subset.
 *
 * @param schema - candidate raw JSON Schema.
 * @param label - what is being validated, for the message.
 */
export function assertSupportedSchema(schema, label) {
  const violations = violationsOf(schema)
  if (violations.length > 0) throw new Error(`${label} is not a supported JSON schema: ${violations.join('; ')}`)
}
