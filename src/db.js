import fs from "node:fs";
import path from "node:path";

const now = () => new Date().toISOString();

const seedBeats = [
  {
    id: "dark-trap",
    name: "Dark Trap",
    genre: "Trap / Hip-Hop",
    bpm: 140,
    key: "Am",
    mood: "aggressive",
    license: "royalty-free demo",
    color: "pink",
    icon: "DT"
  },
  {
    id: "lofi-chill",
    name: "Lo-fi Chill",
    genre: "Lo-fi / R&B",
    bpm: 85,
    key: "Cmaj",
    mood: "warm",
    license: "royalty-free demo",
    color: "cyan",
    icon: "LC"
  },
  {
    id: "afrobeats-bounce",
    name: "Afrobeats Bounce",
    genre: "Afro / Pop",
    bpm: 107,
    key: "Gm",
    mood: "bright",
    license: "royalty-free demo",
    color: "green",
    icon: "AB"
  },
  {
    id: "pop-drill",
    name: "Pop Drill",
    genre: "Drill / Pop",
    bpm: 124,
    key: "F#m",
    mood: "polished",
    license: "royalty-free demo",
    color: "purple",
    icon: "PD"
  },
  {
    id: "guitar-rnb",
    name: "Guitar R&B",
    genre: "R&B / Soul",
    bpm: 96,
    key: "Dmaj",
    mood: "smooth",
    license: "royalty-free demo",
    color: "orange",
    icon: "GR"
  }
];

const seedCommunity = [
  {
    id: "late-night-feelings",
    handle: "@jordanvibes",
    role: "Creator",
    location: "Atlanta, GA",
    title: "Late Night Feelings",
    description: "R&B Vocal + Guitar R&B Beat - Trap Tune preset",
    likes: 1200,
    reposts: 348,
    comments: 87,
    tags: ["rnb", "vocal", "mixforge"]
  },
  {
    id: "club-rotation-vol-3",
    handle: "@djkronic92",
    role: "DJ Pro",
    location: "Miami, FL",
    title: "Club Rotation Mix Vol.3",
    description: "DJ Mix - 47 minutes - Built in DJ Mode",
    likes: 3700,
    reposts: 892,
    comments: 215,
    tags: ["djmix", "club", "djmode"]
  },
  {
    id: "midnight-trap-beat",
    handle: "@makenoise_",
    role: "Producer",
    location: "Chicago, IL",
    title: "Midnight Trap Beat",
    description: "Beat Pack Preview - $9.99 on MixForge",
    likes: 897,
    sales: 134,
    comments: 43,
    tags: ["beats", "trap", "forsale"]
  }
];

function defaultData() {
  return {
    meta: {
      version: 1,
      createdAt: now(),
      updatedAt: now()
    },
    users: [],
    beats: seedBeats,
    recordings: [],
    projects: [],
    stemJobs: [],
    payments: [],
    community: seedCommunity,
    contacts: []
  };
}

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
    this.load();
  }

  load() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      this.data = defaultData();
      this.save();
      return;
    }

    const raw = fs.readFileSync(this.filePath, "utf8");
    this.data = raw.trim() ? JSON.parse(raw) : defaultData();
    this.ensureShape();
  }

  ensureShape() {
    const base = defaultData();
    for (const key of Object.keys(base)) {
      if (this.data[key] === undefined) {
        this.data[key] = base[key];
      }
    }
    if (!Array.isArray(this.data.beats) || this.data.beats.length === 0) {
      this.data.beats = seedBeats;
    }
    if (!Array.isArray(this.data.community) || this.data.community.length === 0) {
      this.data.community = seedCommunity;
    }
    this.data.meta.updatedAt = now();
    this.save();
  }

  save() {
    this.data.meta.updatedAt = now();
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(this.data, null, 2)}\n`);
    fs.renameSync(tmpPath, this.filePath);
  }

  get collectionNames() {
    return Object.keys(this.data).filter((key) => Array.isArray(this.data[key]));
  }

  list(collection) {
    this.assertCollection(collection);
    return this.data[collection];
  }

  find(collection, predicate) {
    return this.list(collection).find(predicate);
  }

  insert(collection, record) {
    this.assertCollection(collection);
    this.data[collection].push(record);
    this.save();
    return record;
  }

  update(collection, id, patch) {
    this.assertCollection(collection);
    const item = this.data[collection].find((record) => record.id === id);
    if (!item) {
      return null;
    }
    Object.assign(item, patch, { updatedAt: now() });
    this.save();
    return item;
  }

  transaction(mutator) {
    const result = mutator(this.data);
    this.save();
    return result;
  }

  assertCollection(collection) {
    if (!this.collectionNames.includes(collection)) {
      throw new Error(`Unknown collection: ${collection}`);
    }
  }
}

export { now };
