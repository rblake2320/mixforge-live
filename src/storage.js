import fs from "node:fs";
import path from "node:path";

// Upload storage behind a small interface so the backend can move from local
// disk to S3/R2 with a config change, not a code change.
//
// - LocalFileStorage: default, zero-config, fully tested. Serves files from disk.
// - S3FileStorage: config-ready for S3/R2 (any S3-compatible object store).
//   Uploads the persisted file and serves via a redirect to a pre-signed URL.
//   Real code, but it requires credentials + @aws-sdk/client-s3, so it is NOT
//   verified in this environment — see the report's "not tested" section.

class LocalFileStorage {
  constructor(uploadRoot) {
    this.uploadRoot = uploadRoot;
    this.kind = "local";
  }

  ensureInside(relativePath) {
    const full = path.resolve(this.uploadRoot, relativePath);
    const root = path.resolve(this.uploadRoot);
    if (full !== root && !full.startsWith(`${root}${path.sep}`)) {
      throw new Error("Unsafe file path.");
    }
    return full;
  }

  // The file is already on disk (multer wrote it); nothing to move.
  async persist(_absoluteTempPath, relativePath) {
    return relativePath;
  }

  async exists(relativePath) {
    try {
      await fs.promises.access(this.ensureInside(relativePath));
      return true;
    } catch {
      return false;
    }
  }

  async serve(res, recording) {
    const full = this.ensureInside(recording.filePath);
    res.type(recording.mimeType);
    return res.sendFile(full);
  }

  async remove(relativePath) {
    await fs.promises.rm(this.ensureInside(relativePath), { force: true });
  }
}

class S3FileStorage {
  constructor(cfg) {
    this.kind = "s3";
    this.bucket = cfg.s3Bucket;
    this.prefix = cfg.s3Prefix || "uploads";
    this.uploadRoot = cfg.uploadRoot;
    this._cfg = cfg;
    this._client = null;
    this._sdk = null;
  }

  async _load() {
    if (this._client) {
      return;
    }
    // Lazy import so the AWS SDK is only required when S3 is actually selected.
    const s3 = await import("@aws-sdk/client-s3");
    const presigner = await import("@aws-sdk/s3-request-presigner");
    this._sdk = { ...s3, getSignedUrl: presigner.getSignedUrl };
    this._client = new s3.S3Client({
      region: this._cfg.s3Region || "us-east-1",
      endpoint: this._cfg.s3Endpoint || undefined,
      forcePathStyle: Boolean(this._cfg.s3Endpoint),
      credentials:
        this._cfg.s3AccessKeyId && this._cfg.s3SecretAccessKey
          ? { accessKeyId: this._cfg.s3AccessKeyId, secretAccessKey: this._cfg.s3SecretAccessKey }
          : undefined
    });
  }

  key(relativePath) {
    return `${this.prefix}/${relativePath}`.replace(/\/+/g, "/");
  }

  async persist(absoluteTempPath, relativePath) {
    await this._load();
    const body = await fs.promises.readFile(absoluteTempPath);
    await this._client.send(
      new this._sdk.PutObjectCommand({ Bucket: this.bucket, Key: this.key(relativePath), Body: body })
    );
    // Local temp copy is no longer the source of truth.
    await fs.promises.rm(absoluteTempPath, { force: true });
    return relativePath;
  }

  async exists(relativePath) {
    await this._load();
    try {
      await this._client.send(new this._sdk.HeadObjectCommand({ Bucket: this.bucket, Key: this.key(relativePath) }));
      return true;
    } catch {
      return false;
    }
  }

  async serve(res, recording) {
    await this._load();
    const url = await this._sdk.getSignedUrl(
      this._client,
      new this._sdk.GetObjectCommand({ Bucket: this.bucket, Key: this.key(recording.filePath) }),
      { expiresIn: 300 }
    );
    return res.redirect(302, url);
  }

  async remove(relativePath) {
    await this._load();
    await this._client.send(new this._sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(relativePath) }));
  }
}

export function createStorage(cfg) {
  const backend = cfg.storageBackend || (cfg.s3Bucket ? "s3" : "local");
  if (backend === "s3") {
    if (!cfg.s3Bucket) {
      throw new Error("S3 storage requires S3_BUCKET.");
    }
    return new S3FileStorage(cfg);
  }
  return new LocalFileStorage(cfg.uploadRoot);
}

export { LocalFileStorage, S3FileStorage };
