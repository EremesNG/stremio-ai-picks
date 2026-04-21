const AGENT_ITEM_SCHEMA = Object.freeze({
  type: "string",
  title: "string",
  year: "number",
  tmdb_id: "number",
});

function formatSchemaForPrompt(schema = AGENT_ITEM_SCHEMA) {
  return Object.entries(schema)
    .map(([field, expectedType]) => `- \`${field}\` (${expectedType})`)
    .join("\n");
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function normalizeGap(gap) {
  if (!Number.isFinite(gap)) return 0;
  if (gap <= 0) return 0;
  return Math.trunc(gap);
}

function validateAgentItems(items, { gap, schema = AGENT_ITEM_SCHEMA } = {}) {
  const requiredGap = normalizeGap(gap);
  const sourceItems = Array.isArray(items) ? items : [];
  const schemaEntries = Object.entries(schema);
  const schemaFields = Object.keys(schema);
  const schemaFieldSet = new Set(schemaFields);

  const validItems = [];
  const invalidItems = [];
  const violations = [];

  sourceItems.forEach((item, itemIndex) => {
    let itemValid = true;

    if (!isPlainObject(item)) {
      itemValid = false;
      invalidItems.push(item);

      for (const [field] of schemaEntries) {
        violations.push({ type: "missing_field", itemIndex, field });
      }

      return;
    }

    for (const [field, expectedType] of schemaEntries) {
      if (!Object.prototype.hasOwnProperty.call(item, field)) {
        itemValid = false;
        violations.push({ type: "missing_field", itemIndex, field });
        continue;
      }

      const actualType = typeof item[field];
      if (actualType !== expectedType) {
        itemValid = false;
        violations.push({
          type: "wrong_type",
          itemIndex,
          field,
          expected: expectedType,
          got: actualType,
        });
      }
    }

    for (const field of Object.keys(item)) {
      if (!schemaFieldSet.has(field)) {
        itemValid = false;
        violations.push({ type: "extra_field", itemIndex, field });
      }
    }

    if (itemValid) {
      validItems.push(item);
      return;
    }

    invalidItems.push(item);
  });

  if (validItems.length < requiredGap) {
    violations.push({
      type: "count_shortfall",
      expected: requiredGap,
      got: validItems.length,
    });
  }

  const valid = violations.length === 0 && validItems.length >= requiredGap;

  return {
    valid,
    validItems,
    invalidItems,
    violations,
  };
}

function buildCorrectiveFeedback({
  violations = [],
  gap,
  schema = AGENT_ITEM_SCHEMA,
} = {}) {
  const normalizedViolations = Array.isArray(violations) ? violations : [];
  const requiredGap = normalizeGap(gap);

  const violationLines = normalizedViolations.map((violation) => {
    const type = violation && violation.type;

    if (type === "count_shortfall") {
      const expected = Number.isFinite(violation.expected)
        ? Math.trunc(violation.expected)
        : requiredGap;
      const got = Number.isFinite(violation.got) ? Math.trunc(violation.got) : 0;
      return `- Count shortfall: You returned ${got} valid items but I need ${expected}. Emit exactly ${expected} valid items.`;
    }

    if (type === "missing_field") {
      const itemNumber = Number.isFinite(violation.itemIndex)
        ? Math.trunc(violation.itemIndex) + 1
        : null;
      const prefix = itemNumber != null ? `Item #${itemNumber}` : "Item";
      return `- ${prefix}: missing required field \`${violation.field}\`.`;
    }

    if (type === "extra_field") {
      const itemNumber = Number.isFinite(violation.itemIndex)
        ? Math.trunc(violation.itemIndex) + 1
        : null;
      const prefix = itemNumber != null ? `Item #${itemNumber}` : "Item";
      return `- ${prefix}: contains forbidden field \`${violation.field}\`.`;
    }

    if (type === "wrong_type") {
      const itemNumber = Number.isFinite(violation.itemIndex)
        ? Math.trunc(violation.itemIndex) + 1
        : null;
      const prefix = itemNumber != null ? `Item #${itemNumber}` : "Item";
      return `- ${prefix}: field \`${violation.field}\` has wrong type (expected ${violation.expected}, got ${violation.got}).`;
    }

    return `- Contract violation: ${JSON.stringify(violation)}.`;
  });

  if (violationLines.length === 0) {
    violationLines.push("- No violations detected in previous response.");
  }

  return [
    "## Violations detected",
    ...violationLines,
    "",
    "## Required output",
    "Return ONLY a JSON array.",
    `Emit exactly ${requiredGap} valid items.`,
    "Each item must contain exactly these fields:",
    formatSchemaForPrompt(schema),
  ].join("\n");
}

module.exports = {
  AGENT_ITEM_SCHEMA,
  formatSchemaForPrompt,
  validateAgentItems,
  buildCorrectiveFeedback,
};
