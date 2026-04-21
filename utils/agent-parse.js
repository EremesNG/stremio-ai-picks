function normalizeRawText(rawText) {
  if (typeof rawText === "string") {
    return rawText;
  }

  if (rawText == null) {
    return "";
  }

  return String(rawText);
}

function stripCodeFences(text) {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
}

function findFirstBalancedArraySpan(text) {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "[") {
      if (start === -1) {
        start = index;
      }

      depth += 1;
      continue;
    }

    if (char === "]" && start !== -1) {
      depth -= 1;

      if (depth === 0) {
        return { start, end: index + 1 };
      }
    }
  }

  return null;
}

function parseJsonArray(text) {
  try {
    const parsed = JSON.parse(text);

    if (!Array.isArray(parsed)) {
      return { items: [], error: "not_json_array" };
    }

    return { items: parsed, error: null };
  } catch (error) {
    return {
      items: [],
      error: error instanceof Error ? error.message : "invalid_json_array",
    };
  }
}

function parseTurnResponse(rawText) {
  const normalizedText = normalizeRawText(rawText);

  if (!normalizedText.trim()) {
    return { items: [], error: "empty_turn" };
  }

  const strippedText = stripCodeFences(normalizedText);

  if (!strippedText) {
    return { items: [], error: "empty_turn" };
  }

  const directParse = parseJsonArray(strippedText);

  if (directParse.error === null) {
    return directParse;
  }

  const arraySpan = findFirstBalancedArraySpan(strippedText);

  if (!arraySpan) {
    return { items: [], error: "no_json_array" };
  }

  const recoveredText = strippedText.slice(arraySpan.start, arraySpan.end);
  const recoveredParse = parseJsonArray(recoveredText);

  if (recoveredParse.error === null) {
    return recoveredParse;
  }

  return {
    items: [],
    error: `recovered_${recoveredParse.error}`,
  };
}

module.exports = {
  parseTurnResponse,
};
