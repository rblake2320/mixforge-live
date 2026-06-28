import { createApp } from "./app.js";
import { config } from "./config.js";
import { assertMinimumProductionConfig } from "./readiness.js";

assertMinimumProductionConfig(config);
const app = createApp(config);

app.listen(config.port, config.host, () => {
  console.log(`MixForge live backend listening on ${config.publicBaseUrl}`);
});
