import { config } from "../src/config.js";
import { evaluateReadiness } from "../src/readiness.js";

const readiness = evaluateReadiness(config);

console.log(JSON.stringify(readiness, null, 2));

if (!readiness.ready) {
  process.exitCode = 1;
}
