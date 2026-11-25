import {
  PLAYBOOK_TOOLS,
  PROJECT_EXTRA_TOOLS,
  TABULAR_TOOLS,
  TOOLS,
  WORKFLOW_TOOLS,
  toolName,
} from "./toolSchemas";

/**
 * What a model is told when one of its tool calls fails inside the tool: a
 * thrown error, most often an argument of a type the tool did not expect (a
 * local model sends `query` as a list). It is that call's result, never the
 * turn's failure, so the model can read it, correct the call and go on.
 *
 * The error itself stays server-side (it may carry storage or database
 * text). What the model gets is the tool's name and, for the platform's own
 * tools, each argument whose JSON type differs from the tool's schema.
 */
export function toolFailureResult(name: string, rawArguments: string): string {
  const problems = argumentProblems(name, parseArguments(rawArguments));
  return JSON.stringify({
    ok: false,
    error: problems.length
      ? `${name} could not run: ${problems.join("; ")}. Correct the arguments and call ${name} again.`
      : `${name} could not complete this call. Check its arguments against the tool's description and call it again, or go on without it.`,
  });
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

type PropertySchema = { type?: unknown };
type ParametersSchema = {
  properties?: Record<string, PropertySchema>;
  required?: unknown;
};

let schemasByName: Map<string, ParametersSchema> | null = null;

function platformSchema(name: string): ParametersSchema | undefined {
  if (!schemasByName) {
    schemasByName = new Map();
    for (const tool of [
      ...TOOLS,
      ...PROJECT_EXTRA_TOOLS,
      ...TABULAR_TOOLS,
      ...WORKFLOW_TOOLS,
      ...PLAYBOOK_TOOLS,
    ]) {
      const toolNamed = toolName(tool);
      const parameters = (tool as { function?: { parameters?: unknown } })
        .function?.parameters;
      if (toolNamed && parameters && typeof parameters === "object") {
        schemasByName.set(toolNamed, parameters as ParametersSchema);
      }
    }
  }
  return schemasByName.get(name);
}

/** A JSON value's type, in the words of a JSON Schema `type`. */
function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

const ARTICLE: Record<string, string> = {
  array: "an array",
  object: "an object",
  integer: "an integer",
};
const named = (type: string) => ARTICLE[type] ?? `a ${type}`;

/** Each top-level argument missing or of the wrong type, in words. */
export function argumentProblems(
  name: string,
  args: Record<string, unknown>,
): string[] {
  const schema = platformSchema(name);
  if (!schema?.properties) return [];
  const problems: string[] = [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key === "string" && args[key] === undefined) {
      problems.push(`${key} is required`);
    }
  }
  for (const [key, property] of Object.entries(schema.properties)) {
    const value = args[key];
    if (value === undefined) continue;
    const declared = Array.isArray(property.type)
      ? property.type.filter((t): t is string => typeof t === "string")
      : typeof property.type === "string"
        ? [property.type]
        : [];
    if (declared.length === 0) continue;
    const actual = jsonType(value);
    const fits = declared.some(
      (type) => type === actual || (type === "number" && actual === "integer"),
    );
    if (!fits) {
      problems.push(
        `${key} must be ${declared.map(named).join(" or ")} (it was ${named(actual)})`,
      );
    }
  }
  return problems;
}
