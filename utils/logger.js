const fs = require("fs");
const path = require("path");

// Use environment variable for logging
const ENABLE_LOGGING = process.env.ENABLE_LOGGING === "true" || false;

// Create logs directory if it doesn't exist (always create it for query logging)
// Skip on Vercel where filesystem is read-only
const logsDir = path.join(__dirname, "..", "logs");
const isVercel = !!process.env.VERCEL;
if (!isVercel && !fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Keep track of last query and timestamp to prevent duplicates
let lastQuery = "";
let lastQueryTime = 0;
const DUPLICATE_WINDOW = 15000; // 15 second window to detect duplicates

/**
 * Helper function to format and write logs
 * @param {string} level - Log level (DEBUG, INFO, WARN, ERROR)
 * @param {string} message - Log message
 * @param {object} data - Optional data to log
 */
function writeLog(level, message, data) {
  // Format the log message
  const timestamp = new Date().toISOString();
  const formattedData = data ? `\n${JSON.stringify(data, null, 2)}` : "";
  const logMessage = `[${timestamp}] ${level}: ${message}${formattedData}\n`;

  // Write to file
  writeToLogFile("app.log", logMessage);
}

/**
 * Helper function to get Melbourne time with DST correction
 * @returns {string} Formatted timestamp
 */
function getMelbourneTime() {
  return new Date()
    .toLocaleString("en-AU", {
      timeZone: "Australia/Melbourne",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
    .replace(/[/]/g, "-")
    .replace(",", "");
}

/**
 * Helper function to log queries independently of ENABLE_LOGGING
 * @param {string} query - The search query
 */
function logQuery(query) {
  const now = Date.now();

  // Check if this is a duplicate query within the time window
  if (query === lastQuery && now - lastQueryTime < DUPLICATE_WINDOW) {
    return; // Skip duplicate query
  }

  // Update last query tracking
  lastQuery = query;
  lastQueryTime = now;

  // Create log line with Melbourne time
  const logLine = `${getMelbourneTime()}|${query}\n`;

  // Write to query log file with error handling
  writeToLogFile("query.log", logLine, (err) => {
    if (err) {
      console.error("Error writing to query.log:", err);
    }
  });
}

/**
 * Helper function to write to a log file (DRY pattern for isVercel + fs.appendFile)
 * @param {string} filename - Name of the log file in logsDir
 * @param {string} message - Message to append
 * @param {function} errorHandler - Optional error handler callback
 */
function writeToLogFile(filename, message, errorHandler) {
  if (isVercel) return;
  fs.appendFile(path.join(logsDir, filename), message, errorHandler || (() => {}));
}

// Simplified logger without console logs, only file logging
const logger = {
  debug: function (message, data) {
    if (ENABLE_LOGGING) {
      writeLog("DEBUG", message, data);
    }
  },
  info: function (message, data) {
    if (ENABLE_LOGGING) {
      writeLog("INFO", message, data);
    }
  },
  warn: function (message, data) {
    if (ENABLE_LOGGING) {
      writeLog("WARN", message, data);
    }
  },
  error: function (message, data) {
    if (ENABLE_LOGGING) {
      writeLog("ERROR", message, data);
    }
  },
  query: logQuery, // Add the query logger to the logger object
  emptyCatalog: function (reason, data = {}) {
    // Skip logging for specific errors we want to ignore
    const skipPatterns = [
      "Invalid IV length",
      "punycode",
      "DeprecationWarning",
      "Missing configuration",
      "Invalid configuration",
      "Missing API keys",
      "Invalid API key",
      "Invalid encrypted data format",
      "Buffer starts with",
      "Got parts",
      "Expected format: 'iv:encrypted'",
      "No search query provided",
    ];

    // Check if any of the skip patterns match the reason or data.error
    const shouldSkip = skipPatterns.some(
      (pattern) =>
        reason.includes(pattern) || (data.error && data.error.includes(pattern))
    );

    if (shouldSkip) {
      return;
    }

    // Always log empty catalogs regardless of ENABLE_LOGGING
    const timestamp = new Date().toISOString();
    const formattedData = JSON.stringify(data, null, 2);
    const logMessage = `[${timestamp}] EMPTY_CATALOG: ${reason}\n${formattedData}\n`;

    // Write to error log file
    writeToLogFile("error.log", logMessage);
  },
  agent: function (label, data) {
    if (ENABLE_LOGGING) {
      const timestamp = new Date().toISOString();
      let formattedData;
      try {
        formattedData = JSON.stringify(data, null, 2);
      } catch (err) {
        formattedData = `[unserializable: ${typeof data}]`;
      }
      const logMessage = `[${timestamp}] [AGENT] [${label}]: ${formattedData}\n---\n`;

      // Write to agent log file
      writeToLogFile("agent.log", logMessage);
    }
  },
  ENABLE_LOGGING,
};

module.exports = logger;
