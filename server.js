// Suppress punycode deprecation warning
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (
    warning.name !== "DeprecationWarning" ||
    !warning.message.includes("punycode")
  ) {
    console.warn(warning);
  }
});

try {
  require("dotenv").config();
} catch (error) {
  logger.warn("dotenv module not found, continuing without .env file support");
}

const fs = require("fs");
const path = require("path");
const {
  addonInterface,
  catalogHandler,
  determineIntentFromKeywords,
  purgeEmptyAiCacheEntries,
  hydrateQueryCounter,
} = require("./addon");
const express = require("express");
const rateLimit = require("express-rate-limit");
const logger = require("./utils/logger");
const { handleIssueSubmission } = require("./utils/issueHandler");
const {
  encryptConfig,
  decryptConfig,
  isValidEncryptedFormat,
} = require("./utils/crypto");
const { initDb, storeTokens, getTokens } = require("./database");
const app = express();
const traktRefreshLocks = new Map();

app.use(express.json({ limit: "10mb" }));

// Admin token for cache management
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "change-me-in-env-file";

// Function to validate admin token
const validateAdminToken = (req, res, next) => {
  const token = req.query.adminToken;

  if (!token || token !== ADMIN_TOKEN) {
    return res
      .status(403)
      .json({ error: "Unauthorized. Invalid admin token." });
  }

  next();
};

async function refreshTraktToken(username, refreshToken) {
  const existingRefreshPromise = traktRefreshLocks.get(username);
  if (existingRefreshPromise) {
    logger.info(`Waiting for in-flight Trakt token refresh for user: ${username}`);
    return existingRefreshPromise;
  }

  const refreshPromise = (async () => {
    logger.info(`Attempting to refresh Trakt token for user: ${username}`);
    try {
      const response = await fetch("https://api.trakt.tv/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "stremio-ai-picks",
          "trakt-api-version": "2",
          "trakt-api-key": TRAKT_CLIENT_ID,
        },
        body: JSON.stringify({
          refresh_token: refreshToken,
          client_id: process.env.TRAKT_CLIENT_ID,
          client_secret: process.env.TRAKT_CLIENT_SECRET,
          redirect_uri: `${HOST}/oauth/callback`,
          grant_type: "refresh_token",
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Failed to refresh token: ${response.status} - ${errorBody}`);
      }

      const tokenData = await response.json();
      await storeTokens(
        username,
        tokenData.access_token,
        tokenData.refresh_token,
        tokenData.expires_in
      );
      logger.info(`Successfully refreshed and stored new Trakt token for user: ${username}`);

      return {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in,
      };
    } catch (error) {
      logger.error(`Error refreshing Trakt token for ${username}:`, { error: error.message });
      return null;
    } finally {
      traktRefreshLocks.delete(username);
    }
  })();

  traktRefreshLocks.set(username, refreshPromise);
  return refreshPromise;
}

const ENABLE_LOGGING = process.env.ENABLE_LOGGING === "true" || false;

if (ENABLE_LOGGING) {
  logger.info("Logging enabled via ENABLE_LOGGING environment variable");
}

const HOST = process.env.HOST
  ? (process.env.HOST.startsWith("http://") || process.env.HOST.startsWith("https://")
      ? process.env.HOST
      : `https://${process.env.HOST}`)
  : "https://github.com/EremesNG/stremio-ai-picks";
const BASE_PATH = "";

const DEFAULT_RPDB_KEY = process.env.RPDB_API_KEY;
const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID;
const TRAKT_CLIENT_SECRET = process.env.TRAKT_CLIENT_SECRET;
const TRAKT_API_BASE = "https://api.trakt.tv";

const setupManifest = {
  id: "eremesng.aipicks",
  version: "1.0.0",
  name: "AI Picks",
  description: "AI-powered movie and series recommendations",
  logo: `${HOST}${BASE_PATH}/logo.png`,
  background: `${HOST}${BASE_PATH}/bg.jpg`,
  resources: ["catalog"],
  types: ["movie", "series"],
  catalogs: [],
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
  },
  configurationURL: `${HOST}${BASE_PATH}/configure`,
};

function startServer() {
  try {
    initDb().catch((err) => logger.error("Failed to initialize database", { error: err.message }));
    logger.info("Running a one-time purge of empty AI cache entries...");
    const purgeStats = purgeEmptyAiCacheEntries();
    logger.info("Empty AI cache purge complete.", purgeStats);
    hydrateQueryCounter().catch((err) => logger.error("Failed to hydrate query counter", { error: err.message }));

    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
      logger.error(
        "CRITICAL ERROR: ENCRYPTION_KEY environment variable is missing or too short!"
      );
      logger.error("The ENCRYPTION_KEY must be at least 32 characters long.");
      logger.error(
        "Please set this environment variable before starting the server."
      );
      process.exit(1);
    }

    app.use((req, res, next) => {
      if (ENABLE_LOGGING) {
        logger.info("Incoming request", {
          method: req.method,
          path: req.path,
          originalUrl: req.originalUrl || req.url,
          query: req.query,
          params: req.params,
          headers: req.headers,
          timestamp: new Date().toISOString(),
        });
      }
      next();
    });

    app.use((req, res, next) => {
      const userAgent = req.headers["user-agent"] || "";
      const platform = req.headers["stremio-platform"] || "";

      let detectedPlatform = "unknown";
      if (
        platform.toLowerCase() === "android-tv" ||
        userAgent.toLowerCase().includes("android tv") ||
        userAgent.toLowerCase().includes("chromecast") ||
        userAgent.toLowerCase().includes("androidtv")
      ) {
        detectedPlatform = "android-tv";
      } else if (
        !userAgent.toLowerCase().includes("stremio/") &&
        (userAgent.toLowerCase().includes("android") ||
          userAgent.toLowerCase().includes("mobile") ||
          userAgent.toLowerCase().includes("phone"))
      ) {
        detectedPlatform = "mobile";
      } else if (
        userAgent.toLowerCase().includes("windows") ||
        userAgent.toLowerCase().includes("macintosh") ||
        userAgent.toLowerCase().includes("linux") ||
        userAgent.toLowerCase().includes("stremio/")
      ) {
        detectedPlatform = "desktop";
      }

      req.stremioInfo = {
        platform: detectedPlatform,
        userAgent: userAgent,
        originalPlatform: platform,
      };

      req.headers["stremio-platform"] = detectedPlatform;
      req.headers["stremio-user-agent"] = userAgent;
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Headers", "*");
      res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.header("Cache-Control", "no-cache");

      if (ENABLE_LOGGING) {
        logger.debug("Platform info", {
          platform: req.stremioInfo?.platform,
          userAgent: req.stremioInfo?.userAgent,
          originalPlatform: req.stremioInfo?.originalPlatform,
        });
      }

      next();
    });

    // Serve static files from public/ directory
    app.use(express.static(path.join(__dirname, "public")));

    const addonRouter = require("express").Router();
    const routeHandlers = {
      manifest: (req, res, next) => {
        next();
      },
      catalog: (req, res, next) => {
        next();
      },
      ping: (req, res) => {
        res.json({
          status: "ok",
          timestamp: new Date().toISOString(),
          platform: req.stremioInfo?.platform || "unknown",
          path: req.path,
        });
      },
    };

    ["/"].forEach((routePath) => {
      // Serve index.html at root
      addonRouter.get(routePath, (req, res) => {
        (async () => {
          try {
            const indexPath = path.join(__dirname, "public", "index.html");
            const html = await fs.promises.readFile(indexPath, "utf8");
            res.setHeader("Content-Type", "text/html");
            res.send(html);
          } catch (error) {
            logger.error("Error loading index page", {
              error: error.message,
              stack: error.stack,
            });
            res.status(500).send("Error loading index page");
          }
        })();
      });

      addonRouter.get(routePath + "manifest.json", (req, res) => {
        const baseManifest = {
          ...setupManifest,
          behaviorHints: {
            ...setupManifest.behaviorHints,
            configurationRequired: true,
          },
        };
        res.json(baseManifest);
      });

      addonRouter.get(routePath + ":config/manifest.json", (req, res) => {
        try {
          const encryptedConfig = req.params.config;
          req.stremioConfig = encryptedConfig;
          let manifestWithConfig = {
            ...addonInterface.manifest,
          };
          
          // Start with only the search catalogs from the base manifest
          manifestWithConfig.catalogs = manifestWithConfig.catalogs.filter(
              catalog => catalog.isSearch === true
          );

          if (encryptedConfig && isValidEncryptedFormat(encryptedConfig)) {
            const decryptedConfigStr = decryptConfig(encryptedConfig);
            if (decryptedConfigStr) {
              try {
                const configData = JSON.parse(decryptedConfigStr);
                const enableHomepage = configData.EnableHomepage !== undefined ? configData.EnableHomepage : true;
                let homepageQueries = configData.HomepageQuery;

                if (enableHomepage) {
                    if (!homepageQueries || homepageQueries.trim() === '') {
                        homepageQueries = "AI Recommendations:recommend a hidden gem movie, AI Recommendations:recommend a binge-worthy series";
                    }
                    const catalogEntries = homepageQueries.split('|||').map(q => q.trim()).filter(Boolean);
                    const homepageCatalogs = [];

                    catalogEntries.forEach((entry, index) => {
                        let title = entry;
                        let query = entry;
                        
                        const parts = entry.split(/:(.*)/s);
                        if (parts.length > 1 && parts[0].trim() && parts[1].trim()) {
                            title = parts[0].trim();
                            query = parts[1].trim();
                        }

                        const intent = determineIntentFromKeywords(query);
                        const id_prefix = `aipicks.home.${index}`;
                        const name = title;

                        if (intent === 'movie' || intent === 'ambiguous') {
                            homepageCatalogs.push({
                                type: 'movie',
                                id: `${id_prefix}.movie`,
                                name: `${name}`
                            });
                        }
                        if (intent === 'series' || intent === 'ambiguous') {
                            homepageCatalogs.push({
                                type: 'series',
                                id: `${id_prefix}.series`,
                                name: `${name}`
                            });
                        }
                    });

                    manifestWithConfig.catalogs.push(...homepageCatalogs);
                }
              } catch (e) {
                logger.warn("Failed to parse decrypted config for manifest generation", { error: e.message });
              }
            }
          }

          manifestWithConfig.behaviorHints = {
            ...manifestWithConfig.behaviorHints,
            configurationRequired: !encryptedConfig,
          };
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Content-Type", "application/json");
          res.send(JSON.stringify(manifestWithConfig));
        } catch (error) {
          if (ENABLE_LOGGING) {
            logger.error("Manifest error:", error);
          }
          res.status(500).send({ error: "Failed to serve manifest" });
        }
      });

      addonRouter.get(
        routePath + ":config/catalog/:type/:id/:extra?.json",
        async (req, res, next) => {
          try {
            if (ENABLE_LOGGING) {
              logger.debug("Received catalog request", {
                type: req.params.type,
                id: req.params.id,
                extra: req.params.extra,
                query: req.query,
              });
            }

            const encryptedConfig = req.params.config;

            if (encryptedConfig && !isValidEncryptedFormat(encryptedConfig)) {
              if (ENABLE_LOGGING) {
                logger.error("Invalid encrypted config format", {
                  configLength: encryptedConfig.length,
                  configSample: encryptedConfig.substring(0, 20) + "...",
                });
              }
              return res.json({ metas: [], error: "Invalid configuration format" });
            }

            // DECRYPT CONFIG and HANDLE TOKENS
            let decryptedConfig = {};
            if (encryptedConfig) {
              const decryptedStr = decryptConfig(encryptedConfig);
              decryptedConfig = JSON.parse(decryptedStr);

               // If user is configured with Trakt, get and refresh tokens if needed
               if (decryptedConfig.traktUsername) {
                 let tokenData = await getTokens(decryptedConfig.traktUsername);
                 if (tokenData) {
                  // expires_at is stored as Unix time in seconds
                  // Refresh if the token is expired or will expire within the next 5 minutes.
                  if (Number(tokenData.expires_at) < Math.floor(Date.now() / 1000) + 300) {
                    const newTokens = await refreshTraktToken(decryptedConfig.traktUsername, tokenData.refresh_token);
                    if (newTokens) {
                      decryptedConfig.TraktAccessToken = newTokens.access_token;
                    } else {
                      // Refresh failed, proceed without a token
                      delete decryptedConfig.TraktAccessToken;
                      decryptedConfig.traktConnectionError = true;
                      logger.warn(`Proceeding without Trakt data for ${decryptedConfig.traktUsername} due to refresh failure.`);
                    }
                  } else {
                    decryptedConfig.TraktAccessToken = tokenData.access_token;
                  }
                }
              }
            }

            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Content-Type", "application/json");

            const searchParam = req.params.extra?.split("search=")[1];
            const searchQuery = searchParam ? decodeURIComponent(searchParam) : req.query.search || "";

            const args = {
              type: req.params.type,
              id: req.params.id,
              extra: { search: searchQuery },
              config: decryptedConfig,
            };

            catalogHandler(args, req)
              .then((response) => {
                const transformedMetas = (response.metas || []).map((meta) => ({
                  ...meta,
                  releaseInfo: meta.year?.toString() || "",
                  genres: (meta.genres || []).map((g) => g.toLowerCase()),
                  trailers: [],
                }));

                if (ENABLE_LOGGING) {
                  logger.debug("Catalog handler response", { metasCount: transformedMetas.length });
                }

                res.json({
                  metas: transformedMetas,
                  cacheAge: response.cacheAge || 3600,
                  staleAge: response.staleAge || 7200,
                });
              })
              .catch((error) => {
                if (ENABLE_LOGGING) {
                  logger.error("Catalog handler error:", { error: error.message, stack: error.stack });
                }
                res.json({ metas: [] });
              });
          } catch (error) {
            if (ENABLE_LOGGING) {
              logger.error("Catalog route error:", { error: error.message, stack: error.stack });
            }
            res.json({ metas: [] });
          }
        }
      );

      addonRouter.get(
        routePath + ":config/meta/:type/:id.json",
        async (req, res) => {
          try {
            if (ENABLE_LOGGING) {
              logger.info("--- META ROUTE MATCHED ---", {
                path: req.path,
                params: req.params,
              });
            }

            const args = {
              type: req.params.type,
              id: req.params.id,
              config: req.params.config,
            };

            const { metaHandler } = require("./addon");
            const response = await metaHandler(args);

            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Content-Type", "application/json");
            res.json(response);

            if (ENABLE_LOGGING) {
              logger.info("[Meta Route] Successfully sent response from metaHandler.", { metaName: response?.meta?.name });
            }
          } catch (error) {
            logger.error("[Meta Route] A CRITICAL error occurred in the meta route handler:", {
              message: error.message,
              stack: error.stack,
            });
            if (!res.headersSent) {
              res.status(500).json({ meta: null, error: "Internal server error" });
            }
          }
        }
      );

      addonRouter.get(
        routePath + ":config/stream/:type/:id.json",
        async (req, res, next) => {
          logger.info("--- STREAM ROUTE MATCHED ---");
          logger.info(`[Stream Route] Path: ${req.path}`);
          logger.info(`[Stream Route] Params: type=${req.params.type}, id=${req.params.id}, config=${req.params.config}`);

          try {

            const args = {
              type: req.params.type,
              id: req.params.id,
              config: req.params.config,
            };

            if (ENABLE_LOGGING) {
              logger.info("[Stream Route] Manually calling the stream handler from addon.js");
            }

            const { streamHandler } = require("./addon");
            const response = await streamHandler(args, req);

            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Content-Type", "application/json");
            res.json(response);

            if (ENABLE_LOGGING) {
              logger.info("[Stream Route] Successfully received response from streamHandler and sent to client.", { streamCount: response?.streams?.length || 0 });
            }

          } catch (error) {
            logger.error("[Stream Route] A CRITICAL error occurred in the route handler itself:", {
              message: error.message,
              stack: error.stack,
            });
            if (!res.headersSent) {
                res.status(500).json({ streams: [], error: "Internal server error" });
            }
          }
        }
      );

      addonRouter.get(routePath + "ping", routeHandlers.ping);
      addonRouter.get(routePath + "configure", (req, res) => {
        (async () => {
          try {
            const templatePath = path.join(__dirname, "public", "configure.html");
            let html = await fs.promises.readFile(templatePath, "utf8");

            html = html.replace('const TRAKT_CLIENT_ID = "YOUR_ADDON_CLIENT_ID";', `const TRAKT_CLIENT_ID = "${TRAKT_CLIENT_ID || ""}";`);
            html = html.replace('const HOST = "your-domain.com";', `const HOST = "${HOST.replace(/^https?:\/\//, "")}";`);

            res.setHeader("Content-Type", "text/html");
            res.send(html);
          } catch (error) {
            logger.error("Error loading configuration page", {
              error: error.message,
              stack: error.stack,
            });
            res.status(500).send("Error loading configuration page");
          }
        })();
      });

      // Add Trakt.tv OAuth callback endpoint
       addonRouter.get(routePath + "oauth/callback", async (req, res) => {
         try {
           const { code } = req.query;
          const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0].trim();
          const forwardedHost = req.get("x-forwarded-host")?.split(",")[0].trim();
          const requestOrigin = `${forwardedProto || req.protocol}://${forwardedHost || req.get("host")}`;

           if (!code) {
             return res.status(400).send(`
               <html lang="en">
                 <body style="background: #141414; color: #d9d9d9; font-family: Arial, sans-serif; text-align: center; padding: 20px;">
                   <h2>Authentication Failed</h2>
                   <p>No authorization code received from Trakt.tv</p>
                   <script>
                     window.close();
                   </script>
                 </body>
               </html>
             `);
          }

          // Exchange the code for an access token
           const tokenResponse = await fetch(
              "https://api.trakt.tv/oauth/token",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "User-Agent": "stremio-ai-picks",
                   "trakt-api-version": "2",
                   "trakt-api-key": TRAKT_CLIENT_ID,
                 },
                  // Match the browser-originated redirect URI exactly, including when behind proxies.
                  // Use the active request base path for the OAuth callback.
                body: JSON.stringify({
                  code,
                  client_id: TRAKT_CLIENT_ID,
                  client_secret: TRAKT_CLIENT_SECRET,
                  redirect_uri: `${requestOrigin}${req.baseUrl || ""}${req.route?.path || "/oauth/callback"}`,
                  grant_type: "authorization_code",
                }),
              }
            );

          if (!tokenResponse.ok) {
            const errorBody = await tokenResponse.text();
              logger.error("Trakt token exchange failed", {
                status: tokenResponse.status,
                body: errorBody,
                redirect_uri: `${requestOrigin}${req.baseUrl || ""}${req.route?.path || "/oauth/callback"}`,
              });
              throw new Error(`Failed to exchange code for token: ${tokenResponse.status}`);
            }

          const tokenData = await tokenResponse.json();

           // Send the token data back to the parent window
           res.send(`
             <html lang="en">
               <body style="background: #141414; color: #d9d9d9; font-family: Arial, sans-serif; text-align: center; padding: 20px;">
                 <h2>Authentication Successful</h2>
                 <p>You can close this window now.</p>
                 <script>
                     if (window.opener) {
                       window.opener.postMessage({
                         type: "TRAKT_AUTH_SUCCESS",
                         access_token: "${tokenData.access_token}",
                         refresh_token: "${tokenData.refresh_token}",
                         expires_in: ${tokenData.expires_in}
                     }, "${requestOrigin}");
                     window.close();
                   }
                 </script>
               </body>
             </html>
           `);
        } catch (error) {
          logger.error("OAuth callback error:", {
            error: error.message,
            stack: error.stack,
          });
          res.status(500).send("Error during OAuth callback");
        }
      });

      // Handle configuration editing with encrypted config
      addonRouter.get(routePath + ":encryptedConfig/configure", (req, res) => {
        const { encryptedConfig } = req.params;

        if (!encryptedConfig || !isValidEncryptedFormat(encryptedConfig)) {
          return res.status(400).send("Invalid configuration format");
        }

         (async () => {
           try {
             const templatePath = path.join(__dirname, "public", "configure.html");
             let html = await fs.promises.readFile(templatePath, "utf8");

             html = html.replace('const TRAKT_CLIENT_ID = "YOUR_ADDON_CLIENT_ID";', `const TRAKT_CLIENT_ID = "${TRAKT_CLIENT_ID || ""}";`);
             html = html.replace('const HOST = "your-domain.com";', `const HOST = "${HOST.replace(/^https?:\/\//, "")}";`);
             html = html.replace(
               /(<input\s+type="hidden"\s+id="existingConfigId"\s+name="existingConfigId"\s+value=")([^"]*)("\s*\/?>)/,
               `$1${encryptedConfig}$3`
             );

            res.setHeader("Content-Type", "text/html");
            res.send(html);
          } catch (error) {
            logger.error("Error loading configuration page", {
              error: error.message,
              stack: error.stack,
            });
            res.status(500).send("Error loading configuration page");
          }
        })();
      });

      // Update the getConfig endpoint to handle the full path
      addonRouter.get(routePath + "api/getConfig/:configId", (req, res) => {
        try {
          const { configId } = req.params;

          // Remove any path prefix if present
          const cleanConfigId = configId.split("/").pop();

          if (!cleanConfigId || !isValidEncryptedFormat(cleanConfigId)) {
            return res
              .status(400)
              .json({ error: "Invalid configuration format" });
          }

          const decryptedConfig = decryptConfig(cleanConfigId);
          if (!decryptedConfig) {
            return res
              .status(400)
              .json({ error: "Failed to decrypt configuration" });
          }

          // Parse and return the configuration
          const config = JSON.parse(decryptedConfig);
          res.json(config);
        } catch (error) {
          logger.error("Error getting configuration:", {
            error: error.message,
            stack: error.stack,
          });
          res.status(500).json({ error: "Internal server error" });
        }
      });

      addonRouter.get(
        routePath + "cache/stats",
        validateAdminToken,
        (req, res) => {
          const { getCacheStats } = require("./addon");
          res.json(getCacheStats());
        }
      );

      // API endpoint to decrypt configuration
      addonRouter.post(routePath + "api/decrypt-config", (req, res) => {
        try {
          const { encryptedConfig } = req.body;

          if (!encryptedConfig || !isValidEncryptedFormat(encryptedConfig)) {
            return res
              .status(400)
              .json({ error: "Invalid configuration format" });
          }

          const decryptedConfig = decryptConfig(encryptedConfig);

          if (!decryptedConfig) {
            return res
              .status(400)
              .json({ error: "Failed to decrypt configuration" });
          }

          // Parse the decrypted JSON
          const config = JSON.parse(decryptedConfig);

          // Return the configuration object
          res.json(config);
        } catch (error) {
          logger.error("Error decrypting configuration:", {
            error: error.message,
            stack: error.stack,
          });
          res.status(500).json({ error: "Internal server error" });
        }
      });

      addonRouter.get(
        routePath + "cache/clear/tmdb",
        validateAdminToken,
        (req, res) => {
          const { clearTmdbCache } = require("./addon");
          res.json(clearTmdbCache());
        }
      );

      addonRouter.get(
        routePath + "cache/clear/tmdb-details",
        validateAdminToken,
        (req, res) => {
          const { clearTmdbDetailsCache } = require("./addon");
          res.json(clearTmdbDetailsCache());
        }
      );

      addonRouter.get(
        routePath + "cache/clear/tmdb-discover",
        validateAdminToken,
        (req, res) => {
          const { clearTmdbDiscoverCache } = require("./addon");
          res.json(clearTmdbDiscoverCache());
        }
      );

      addonRouter.get(
        routePath + "cache/clear/ai",
        validateAdminToken,
        (req, res) => {
          try {
            const { clearAiCache } = require("./addon");
            const result = clearAiCache();
            res.json(result);
          } catch (error) {
            logger.error("Error in cache/clear/ai endpoint:", { error: error.message, stack: error.stack });
            res.status(500).json({ error: "Internal server error", message: error.message });
          }
        }
      );

      addonRouter.get(
        routePath + "cache/clear/ai/keywords",
        validateAdminToken,
        (req, res) => {
          try {
            const keywords = req.query.keywords;
            if (!keywords || typeof keywords !== "string") {
              return res.status(400).json({
                error: "Keywords parameter is required and must be a string",
              });
            }

            const { removeAiCacheByKeywords } = require("./addon");
            const result = removeAiCacheByKeywords(keywords);

            if (!result) {
              return res
                .status(500)
                .json({ error: "Failed to remove cache entries" });
            }

            res.json(result);
          } catch (error) {
            logger.error("Error in cache/clear/ai/keywords endpoint:", {
              error: error.message,
              stack: error.stack,
              keywords: req.query.keywords,
            });
            res.status(500).json({
              error: "Internal server error",
              message: error.message,
            });
          }
        }
      );

      addonRouter.get(
        routePath + "cache/purge/ai-empty",
        validateAdminToken,
        (req, res) => {
          try {
            const { purgeEmptyAiCacheEntries } = require("./addon");
            const stats = purgeEmptyAiCacheEntries();
            res.json({
              message: "Purge of empty AI cache entries completed.",
              ...stats
            });
          } catch (error) {
            logger.error("Error in cache/purge/ai-empty endpoint:", {
              error: error.message,
              stack: error.stack,
            });
            res.status(500).json({
              error: "Internal server error",
              message: error.message,
            });
          }
        }
      );

      addonRouter.get(
        routePath + "cache/clear/rpdb",
        validateAdminToken,
        (req, res) => {
          const { clearRpdbCache } = require("./addon");
          res.json(clearRpdbCache());
        }
      );

      addonRouter.get(
        routePath + "cache/clear/trakt",
        validateAdminToken,
        (req, res) => {
          const { clearTraktCache } = require("./addon");
          res.json(clearTraktCache());
        }
      );

      addonRouter.get(
        routePath + "cache/clear/trakt-raw",
        validateAdminToken,
        (req, res) => {
          const { clearTraktRawDataCache } = require("./addon");
          res.json(clearTraktRawDataCache());
        }
      );

      addonRouter.get(
        routePath + "cache/clear/query-analysis",
        validateAdminToken,
        (req, res) => {
          const { clearQueryAnalysisCache } = require("./addon");
          res.json(clearQueryAnalysisCache());
        }
      );

      // Add endpoint to remove a specific TMDB discover cache item
      addonRouter.get(
        routePath + "cache/remove/tmdb-discover",
        validateAdminToken,
        (req, res) => {
          const { removeTmdbDiscoverCacheItem } = require("./addon");
          const cacheKey = req.query.key;
          res.json(removeTmdbDiscoverCacheItem(cacheKey));
        }
      );

      // Add endpoint to list all TMDB discover cache keys
      addonRouter.get(
        routePath + "cache/list/tmdb-discover",
        validateAdminToken,
        (req, res) => {
          const { listTmdbDiscoverCacheKeys } = require("./addon");
          res.json(listTmdbDiscoverCacheKeys());
        }
      );

      addonRouter.get(
        routePath + "cache/clear/all",
        validateAdminToken,
        (req, res) => {
          try {
            const {
              clearTmdbCache,
              clearTmdbDetailsCache,
              clearTmdbDiscoverCache,
              clearAiCache,
              clearRpdbCache,
              clearTraktCache,
              clearTraktRawDataCache,
              clearQueryAnalysisCache,
            } = require("./addon");
            const tmdbResult = clearTmdbCache();
            const tmdbDetailsResult = clearTmdbDetailsCache();
            const tmdbDiscoverResult = clearTmdbDiscoverCache();
            const aiResult = clearAiCache();
            const rpdbResult = clearRpdbCache();
            const traktResult = clearTraktCache();
            const traktRawResult = clearTraktRawDataCache();
            const queryAnalysisResult = clearQueryAnalysisCache();
            res.json({
              tmdb: tmdbResult,
              tmdbDetails: tmdbDetailsResult,
              tmdbDiscover: tmdbDiscoverResult,
              ai: aiResult,
              rpdb: rpdbResult,
              trakt: traktResult,
              traktRaw: traktRawResult,
              queryAnalysis: queryAnalysisResult,
            });
          } catch (error) {
            logger.error("Error in cache/clear/all endpoint:", { error: error.message, stack: error.stack });
            res.status(500).json({ error: "Internal server error", message: error.message });
          }
        }
      );

      // Add endpoint to set query counter
      addonRouter.post(
        routePath + "stats/count/set",
        validateAdminToken,
        express.json(),
        (req, res) => {
          try {
            const { count } = req.body;
            if (typeof count !== "number" || count < 0) {
              return res.status(400).json({
                error: "Count must be a non-negative number",
              });
            }
            const { setQueryCount } = require("./addon");
            const newCount = setQueryCount(count);
            res.json({
              success: true,
              newCount,
              message: `Query counter set to ${newCount}`,
            });
          } catch (error) {
            res.status(400).json({
              error: error.message,
            });
          }
        }
      );

      // Add stats endpoint to the addonRouter
      addonRouter.get(routePath + "stats/count", (req, res) => {
        const { getQueryCount } = require("./addon");
        const count = getQueryCount();

        // Check if the request wants JSON or widget HTML
        const format = req.query.format || "json";

        if (format === "json") {
          res.json({ count });
         } else if (format === "widget") {
           res.send(`
             <!DOCTYPE html>
             <html lang="en">
             <head>
               <meta charset="UTF-8">
               <meta name="viewport" content="width=device-width, initial-scale=1.0">
               <title>Stremio AI Search Stats</title>
              <style>
                body {
                  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                  margin: 0;
                  padding: 0;
                  display: flex;
                  justify-content: center;
                  align-items: center;
                  height: 100vh;
                  background-color: transparent;
                }
                .counter {
                  background-color: #1e1e1e;
                  color: #ffffff;
                  border-radius: 8px;
                  padding: 15px 25px;
                  text-align: center;
                  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                  min-width: 200px;
                }
                .count {
                  font-size: 2.5rem;
                  font-weight: bold;
                  margin: 10px 0;
                  color: #00b3ff;
                }
                .label {
                  font-size: 1rem;
                  opacity: 0.8;
                }
              </style>
            </head>
            <body>
              <div class="counter">
                <div class="count">${count.toLocaleString()}</div>
                <div class="label">user queries served</div>
              </div>
            </body>
            </html>
          `);
        } else if (format === "badge") {
          // Simple text for embedding in markdown or other places
          res
            .type("text/plain")
            .send(`${count.toLocaleString()} queries served`);
        } else {
          res.status(400).json({
            error: "Invalid format. Use 'json', 'widget', or 'badge'",
          });
        }
      });

      // Add an embeddable widget endpoint to the addonRouter
      addonRouter.get(routePath + "stats/widget.js", (req, res) => {
        res.type("application/javascript").send(`
          (function() {
            const widgetContainer = document.createElement('div');
            widgetContainer.id = 'stremio-ai-search-counter';
            widgetContainer.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
            widgetContainer.style.backgroundColor = '#1e1e1e';
            widgetContainer.style.color = '#ffffff';
            widgetContainer.style.borderRadius = '8px';
            widgetContainer.style.padding = '15px 25px';
            widgetContainer.style.textAlign = 'center';
            widgetContainer.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.1)';
            widgetContainer.style.minWidth = '200px';
            widgetContainer.style.margin = '10px auto';
            
            // Insert the widget where the script is included
            const currentScript = document.currentScript;
            currentScript.parentNode.insertBefore(widgetContainer, currentScript);
            
            function updateCounter() {
              fetch('${HOST}${BASE_PATH}/stats/count?format=json')
                .then(response => response.json())
                .then(data => {
                  widgetContainer.innerHTML = \`
                    <div style="font-size: 2.5rem; font-weight: bold; margin: 10px 0; color: #00b3ff;">\${data.count.toLocaleString()}</div>
                    <div style="font-size: 1rem; opacity: 0.8;">user queries served</div>
                  \`;
                })
                .catch(error => {
                  widgetContainer.innerHTML = '<div>Error loading stats</div>';
                  logger.error('Error fetching stats:', error);
                });
            }
            
            // Initial update
            updateCounter();
            
            // Update every 5 minutes
            setInterval(updateCounter, 5 * 60 * 1000);
          })();
        `);
      });

       // Update Trakt.tv token refresh endpoint to use pre-configured credentials
       addonRouter.post("/oauth/refresh", async (req, res) => {
         try {
           const { refresh_token } = req.body;

           if (!refresh_token) {
             return res.status(400).json({ error: "Missing refresh token" });
           }

            const response = await fetch("https://api.trakt.tv/oauth/token", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": "stremio-ai-picks",
                "trakt-api-version": "2",
                "trakt-api-key": TRAKT_CLIENT_ID,
              },
             body: JSON.stringify({
               refresh_token,
               client_id: TRAKT_CLIENT_ID,
               client_secret: TRAKT_CLIENT_SECRET,
         redirect_uri: `${HOST}/oauth/callback`,
               grant_type: "refresh_token",
             }),
           });

          if (!response.ok) {
            throw new Error("Failed to refresh token");
          }

          const tokenData = await response.json();
          res.json(tokenData);
        } catch (error) {
          logger.error("Token refresh error:", {
            error: error.message,
            stack: error.stack,
          });
          res.status(500).json({ error: "Failed to refresh token" });
        }
      });
    });

    app.use("/", addonRouter);

    app.post("/encrypt", express.json(), async (req, res) => {
      try {
        const { configData, traktAuthData } = req.body;
        if (!configData) {
          return res.status(400).json({ error: "Missing config data" });
        }

        // If Trakt data is present, store it in the database
        if (traktAuthData && traktAuthData.username) {
          await storeTokens(
            traktAuthData.username,
            traktAuthData.accessToken,
            traktAuthData.refreshToken,
            traktAuthData.expiresIn
          );
          configData.traktUsername = traktAuthData.username;
        }

        if (!configData.RpdbApiKey) {
          delete configData.RpdbApiKey;
        }

        const configStr = JSON.stringify(configData);
        const encryptedConfig = encryptConfig(configStr);

        if (!encryptedConfig) {
          return res.status(500).json({ error: "Encryption failed" });
        }

        return res.json({
          encryptedConfig,
          usingDefaultRpdb: !configData.RpdbApiKey && !!DEFAULT_RPDB_KEY,
        });
      } catch (error) {
        logger.error("Encryption endpoint error:", {
          error: error.message,
          stack: error.stack,
        });
        return res.status(500).json({ error: "Server error" });
      }
    });

    app.post("/decrypt", express.json(), (req, res) => {
      try {
        const { encryptedConfig } = req.body;
        if (!encryptedConfig) {
          return res.status(400).json({ error: "Missing encrypted config" });
        }

        const decryptedConfig = decryptConfig(encryptedConfig);
        if (!decryptedConfig) {
          return res.status(500).json({ error: "Decryption failed" });
        }

        try {
          const configData = JSON.parse(decryptedConfig);
          return res.json({ success: true, config: configData });
        } catch (error) {
          return res
            .status(500)
            .json({ error: "Invalid JSON in decrypted config" });
        }
      } catch (error) {
        logger.error("Decryption endpoint error:", {
          error: error.message,
          stack: error.stack,
        });
        return res.status(500).json({ error: "Server error" });
      }
    });

    app.use(
      ["/encrypt", "/decrypt"],
      (req, res, next) => {
        res.header("Access-Control-Allow-Origin", "*");
        res.header(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization"
        );
        res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

        if (req.method === "OPTIONS") {
          return res.sendStatus(200);
        }

        next();
      }
    );

app.use("/validate", (req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.post("/validate", express.json(), async (req, res) => {
  const startTime = Date.now();
  try {
    const {
      GeminiApiKey,
      TmdbApiKey,
      GeminiModel,
      TraktAccessToken,
      FanartApiKey,
      traktUsername,
    } = req.body;
    
    const validationResults = {
      gemini: false,
      tmdb: false,
      fanart: true, // Optional, so default to true
      trakt: true,
      errors: {},
    };
    
    const modelToUse = GeminiModel || "gemini-flash-lite-latest";

    if (ENABLE_LOGGING) {
      logger.debug("Validation request received", {
        path: req.path,
        hasGeminiKey: !!GeminiApiKey,
        hasTmdbKey: !!TmdbApiKey,
        hasTraktToken: !!TraktAccessToken,
        hasTraktUsername: !!traktUsername,
      });
    }

    const validations = [];

    // Gemini Validation
    if (GeminiApiKey) {
      validations.push((async () => {
        try {
          const { GoogleGenAI } = require("@google/genai");
          const ai = new GoogleGenAI({ apiKey: GeminiApiKey });
          const result = await ai.models.generateContent({
            model: modelToUse,
            contents: "Test prompt",
          });
          const responseText = result.text;
          if (responseText.length > 0) {
            validationResults.gemini = true;
          } else {
            validationResults.errors.gemini = "Invalid Gemini API key - No response";
          }
        } catch (error) {
          validationResults.errors.gemini = `Invalid Gemini API key: ${error.message}`;
        }
      })());
    } else {
       validationResults.errors.gemini = "Gemini API Key is required.";
    }

    // TMDB Validation
    if (TmdbApiKey) {
      validations.push((async () => {
        try {
          const tmdbUrl = `https://api.themoviedb.org/3/configuration?api_key=${TmdbApiKey}`;
          const tmdbResponse = await fetch(tmdbUrl);
          if (tmdbResponse.ok) {
            validationResults.tmdb = true;
          } else {
            validationResults.errors.tmdb = `Invalid TMDB API key (Status: ${tmdbResponse.status})`;
          }
        } catch (error) {
          validationResults.errors.tmdb = "TMDB API validation failed";
        }
      })());
    } else {
        validationResults.errors.tmdb = "TMDB API Key is required.";
    }

    // Fanart.tv Validation (Optional)
    if (FanartApiKey) {
      validations.push((async () => {
        try {
          // Test with a known movie (Harry Potter) to validate the API key
          const fanartUrl = `http://webservice.fanart.tv/v3/movies/120?api_key=${FanartApiKey}`;
          const fanartResponse = await fetch(fanartUrl);
          if (fanartResponse.ok) {
            const data = await fanartResponse.json();
            if (data && (data.moviethumb || data.hdmovielogo || data.movieposter)) {
              validationResults.fanart = true;
            } else {
              validationResults.errors.fanart = "Fanart.tv API key valid but no data returned";
            }
          } else if (fanartResponse.status === 401) {
            validationResults.fanart = false;
            validationResults.errors.fanart = "Invalid Fanart.tv API key";
          } else {
            validationResults.fanart = false;
            validationResults.errors.fanart = `Fanart.tv API error (Status: ${fanartResponse.status})`;
          }
        } catch (error) {
          validationResults.fanart = false;
          validationResults.errors.fanart = "Fanart.tv API validation failed";
        }
      })());
    }
    // Note: Fanart.tv is optional, so no error if missing

    // --- NEW TRAKT VALIDATION LOGIC ---
    let tokenToCheck = TraktAccessToken;

     // If a username is provided, this is a health check. Get the token from the DB.
     if (traktUsername) {
       const tokenData = await getTokens(traktUsername);
      if (tokenData && tokenData.access_token) {
        tokenToCheck = tokenData.access_token;
      } else {
        tokenToCheck = null; // No token found in DB
        validationResults.trakt = false;
        validationResults.errors.trakt = "No stored Trakt credentials found for this user.";
      }
    }

    // Now, validate the token we found (either from the request body or the DB)
    if (tokenToCheck) {
      validations.push((async () => {
        try {
           const traktResponse = await fetch(`${TRAKT_API_BASE}/users/me`, {
             headers: {
               "Content-Type": "application/json",
               "User-Agent": "stremio-ai-search",
               "trakt-api-version": "2",
               "trakt-api-key": TRAKT_CLIENT_ID,
               Authorization: `Bearer ${tokenToCheck}`,
             },
           });
          if (!traktResponse.ok) {
            validationResults.trakt = false;
            validationResults.errors.trakt = "Trakt.tv connection is invalid. Please re-login.";
          } else {
            validationResults.trakt = true; // Explicitly confirm it's valid
          }
        } catch (error) {
          validationResults.trakt = false;
          validationResults.errors.trakt = "Trakt.tv API validation failed.";
        }
      })());
    } else if (TraktAccessToken || traktUsername) {
      // If we expected a token but didn't have one to check, it's a failure.
      validationResults.trakt = false;
      if (!validationResults.errors.trakt) {
        validationResults.errors.trakt = "Missing Trakt access token for validation.";
      }
    }
    
    // Wait for all validations to complete
    await Promise.all(validations);

    if (ENABLE_LOGGING) {
      logger.debug("API key validation results:", {
        results: validationResults,
        duration: `${Date.now() - startTime}ms`,
      });
    }

    res.json(validationResults);
  } catch (error) {
    if (ENABLE_LOGGING) {
      logger.error("Validation endpoint error:", {
        error: error.message,
        stack: error.stack,
      });
    }
    res.status(500).json({
      error: "Validation failed due to a server error.",
      message: error.message,
    });
  }
});

    app.get("/test-crypto", (req, res) => {
      try {
        const testData = JSON.stringify({
          test: "data",
          timestamp: Date.now(),
        });

        const encrypted = encryptConfig(testData);
        const decrypted = decryptConfig(encrypted);

        res.json({
          original: testData,
          encrypted: encrypted,
          decrypted: decrypted,
          success: testData === decrypted,
          encryptedLength: encrypted ? encrypted.length : 0,
          decryptedLength: decrypted ? decrypted.length : 0,
        });
      } catch (error) {
        res.status(500).json({
          error: error.message,
          stack: error.stack,
        });
      }
    });

    // Add rate limiter for issue submissions
    const issueRateLimiter = rateLimit({
      windowMs: 60 * 60 * 1000, // 1 hour window
      max: 5, // limit each IP to 5 submissions per window
      message: {
        error:
          "Too many submissions from this IP, please try again after an hour",
      },
      standardHeaders: true,
      legacyHeaders: false,
    });

    // Add the issue submission endpoint to the addonRouter
    addonRouter.post(
      "/submit-issue",
      issueRateLimiter,
      express.json(),
      async (req, res) => {
        try {
          if (ENABLE_LOGGING) {
            logger.debug("Issue submission received", {
              title: req.body.title,
              feedbackType: req.body.feedbackType,
              email: req.body.email,
              hasRecaptcha: !!req.body.recaptchaToken,
              timestamp: new Date().toISOString(),
            });
          }

          const result = await handleIssueSubmission(req.body);
          res.json(result);
        } catch (error) {
          if (ENABLE_LOGGING) {
            logger.error("Issue submission error:", {
              error: error.message,
              stack: error.stack,
              timestamp: new Date().toISOString(),
            });
          }
          res.status(400).json({ error: error.message });
        }
      }
    );

  } catch (error) {
    if (ENABLE_LOGGING) {
      logger.error("Server error:", {
        error: error.message,
        stack: error.stack,
      });
    }
    process.exit(1);
  }
}

startServer();

module.exports = app;
