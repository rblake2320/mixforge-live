import { createApp } from "./app.js";
import { config } from "./config.js";
import { assertMinimumProductionConfig } from "./readiness.js";

assertMinimumProductionConfig(config);
const app = createApp(config);

const server = app.listen(config.port, config.host, () => {
  app.locals.logStore?.log("system_infrastructure", {
    eventType: "server_listening",
    severity: "INFO",
    outcome: "success",
    what: {
      host: config.host,
      port: config.port,
      publicBaseUrl: config.publicBaseUrl
    }
  });
  console.log(`MixForge live backend listening on ${config.publicBaseUrl}`);
});

function shutdown(signal = "unknown") {
  app.locals.logStore?.log("system_infrastructure", {
    eventType: "server_shutdown_requested",
    severity: "WARN",
    outcome: "deferred",
    what: { signal }
  });
  server.close(() => {
    app.locals.logStore?.log("system_infrastructure", {
      eventType: "server_shutdown_completed",
      severity: "INFO",
      outcome: "success",
      what: { signal }
    });
    app.locals.logStore?.flushSync();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  app.locals.logStore?.log("error", {
    eventType: "uncaught_exception",
    severity: "CRITICAL",
    outcome: "failure",
    error
  });
  app.locals.logStore?.flushSync();
  console.error(error);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  app.locals.logStore?.log("error", {
    eventType: "unhandled_rejection",
    severity: "ERROR",
    outcome: "failure",
    error
  });
  console.error(error);
});
