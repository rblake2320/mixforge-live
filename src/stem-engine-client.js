import fs from "node:fs";
import path from "node:path";

// Client for the self-hosted MixForge stem engine (stem-engine/engine.py).
// Implements the same surface the StemSplit SDK exposes (jobs.create/get plus
// the youtube/soundcloud resources), so createApp can inject it through the
// existing stemsplitClient() seam with a config change and no route rewrites.
//
// The engine only processes audio it is handed directly — an uploaded file or
// a direct http(s) audio URL. Streaming-site imports (YouTube / SoundCloud)
// stay a hosted-provider feature and fail loudly here.

const CREATE_TIMEOUT_MS = 120_000; // uploads can be large; engine is local/LAN
const GET_TIMEOUT_MS = 30_000;

function streamingImportError(kind) {
  const error = new Error(
    `${kind} import is not supported by the local stem engine. Upload the audio file directly, or configure the hosted StemSplit provider for link imports.`
  );
  error.status = 400;
  return error;
}

export class StemEngineClient {
  constructor({ baseUrl, apiKey = "" }) {
    if (!baseUrl) {
      throw new Error("StemEngineClient requires a baseUrl.");
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;

    this.jobs = {
      create: (payload) => this.#create(payload),
      get: (id) => this.#get(id)
    };
    this.youtubeJobs = {
      create: () => Promise.reject(streamingImportError("YouTube")),
      get: () => Promise.reject(streamingImportError("YouTube"))
    };
    this.soundcloudJobs = {
      create: () => Promise.reject(streamingImportError("SoundCloud")),
      get: () => Promise.reject(streamingImportError("SoundCloud"))
    };
  }

  #headers(extra = {}) {
    return this.apiKey ? { "X-API-Key": this.apiKey, ...extra } : extra;
  }

  async #parse(response, operation) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Stem engine ${operation} failed (${response.status}): ${body.detail || body.error || "unknown error"}`);
    }
    return body;
  }

  async #create({ audio, sourceUrl }) {
    if (sourceUrl) {
      const response = await fetch(`${this.baseUrl}/v1/jobs/url`, {
        method: "POST",
        headers: this.#headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ sourceUrl }),
        signal: AbortSignal.timeout(CREATE_TIMEOUT_MS)
      });
      return this.#parse(response, "url job create");
    }
    if (!audio) {
      throw new Error("Stem engine create requires an audio path or sourceUrl.");
    }
    const buffer = await fs.promises.readFile(audio);
    const form = new FormData();
    form.append("audio", new Blob([buffer]), path.basename(audio));
    const response = await fetch(`${this.baseUrl}/v1/jobs`, {
      method: "POST",
      headers: this.#headers(),
      body: form,
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS)
    });
    return this.#parse(response, "job create");
  }

  async #get(id) {
    const response = await fetch(`${this.baseUrl}/v1/jobs/${encodeURIComponent(id)}`, {
      headers: this.#headers(),
      signal: AbortSignal.timeout(GET_TIMEOUT_MS)
    });
    return this.#parse(response, "job get");
  }
}
