import { db } from "../db";
import { categories } from "../db/schema";
import { eq } from "drizzle-orm";

// ── Keyword map ───────────────────────────────────────────────────────────────
// Ensure you always store: name → normalized (e.g. Title Case or lowercase)
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  Technology: [
    // Your original
    "ai",
    "tech",
    "software",
    "startup",
    "mobile",
    "cyber",
    "digital",
    "app",
    "robot",
    "spacex",
    "samsung",
    "apple",
    "google",

    // AI / Emerging Tech (VERY IMPORTANT for 2026 feeds)
    "artificial intelligence",
    "machine learning",
    "deep learning",
    "generative ai",
    "chatgpt",
    "openai",
    "llm",
    "automation",
    "claude",
    "anthropic",
    "deepseek",
    "kimi",
    "open claw",

    // Big Tech / Companies
    "microsoft",
    "meta",
    "amazon",
    "aws",
    "tesla",
    "nvidia",
    "intel",
    "ibm",
    "oracle",

    // Software / Development
    "developer",
    "programming",
    "coding",
    "javascript",
    "typescript",
    "python",
    "react",
    "node",
    "api",
    "backend",
    "frontend",
    "fullstack",
    "framework",
    "github",
    "open source",

    // Infrastructure / Cloud
    "cloud",
    "cloud computing",
    "server",
    "database",
    "devops",
    "kubernetes",
    "docker",
    "infrastructure",

    // Security / Cyber
    "cybersecurity",
    "hacking",
    "malware",
    "ransomware",
    "data breach",
    "encryption",
    "privacy",

    // Devices / Hardware
    "smartphone",
    "laptop",
    "chip",
    "semiconductor",
    "processor",
    "gpu",
    "hardware",
    "iot",
    "wearables",

    // Internet / Platforms
    "internet",
    "social media",
    "platform",
    "saas",
    "web",
    "browser",

    // Innovation / Trends
    "blockchain",
    "crypto",
    "fintech",
    "vr",
    "ar",
    "metaverse",
    "quantum computing",
    "biotech",
    "robotics",

    // Space / Advanced Tech
    "space",
    "satellite",
    "rocket",
    "nasa",

    // Business of Tech
    "funding",
    "venture capital",
    "ipo",
    "acquisition",
    "merger",
    "valuation",
  ],
  Business: [
    // Your original
    "market",
    "finance",
    "economy",
    "stock",
    "trade",
    "gdp",
    "inflation",
    "investment",

    // Core Business Terms
    "business",
    "company",
    "corporate",
    "industry",
    "enterprise",
    "firm",
    "commerce",

    // Financial / Markets
    "stocks",
    "shares",
    "equities",
    "bond",
    "bonds",
    "yield",
    "interest rate",
    "federal reserve",
    "central bank",
    "forex",
    "currency",
    "exchange rate",
    "naira",
    "dollar",
    "oil price",
    "commodity",

    // Companies / Earnings
    "earnings",
    "revenue",
    "profit",
    "loss",
    "quarterly results",
    "financial results",
    "balance sheet",
    "cash flow",

    // Deals / Corporate Activity
    "acquisition",
    "merger",
    "takeover",
    "buyout",
    "ipo",
    "listing",
    "valuation",
    "deal",

    // Startups / Venture
    "startup",
    "founder",
    "venture capital",
    "vc",
    "funding",
    "seed funding",
    "series a",
    "series b",
    "unicorn",

    // Economy / Policy
    "recession",
    "economic growth",
    "fiscal policy",
    "monetary policy",
    "subsidy",
    "tax",
    "tariff",
    "budget",

    // Jobs / Labor
    "employment",
    "unemployment",
    "jobs",
    "labor",
    "wages",
    "salary",

    // Banking / Fintech
    "bank",
    "banking",
    "fintech",
    "payment",
    "digital payment",
    "mobile money",
    "loan",
    "credit",
    "debt",

    // Global / Trade
    "exports",
    "imports",
    "supply chain",
    "logistics",
    "shipping",

    // Nigeria-specific (VERY IMPORTANT for your app)
    "cbn",
    "nigerian economy",
    "lagos business",
    "africa business",
  ],
  Politics: [
    // Your original
    "election",
    "government",
    "policy",
    "president",
    "parliament",
    "senate",
    "congress",
    "vote",

    // Core Political Terms
    "politics",
    "political",
    "governance",
    "administration",
    "leadership",
    "public office",

    // Elections / Voting
    "campaign",
    "candidate",
    "ballot",
    "poll",
    "voter",
    "electoral",
    "primaries",
    "runoff",
    "election results",

    // Government Institutions
    "lawmakers",
    "legislature",
    "house of representatives",
    "assembly",
    "cabinet",
    "minister",
    "ministry",
    "governor",
    "mayor",
    "prime minister",

    // Policy / Law
    "bill",
    "law",
    "legislation",
    "regulation",
    "reform",
    "executive order",
    "decree",
    "constitution",
    "amendment",

    // Political Parties / Ideology
    "party",
    "opposition",
    "ruling party",
    "democracy",
    "democratic",
    "republic",
    "republican",
    "liberal",
    "conservative",

    // Governance / Public Affairs
    "public policy",
    "governance reform",
    "accountability",
    "transparency",
    "corruption",
    "anti-corruption",
    "scandal",

    // International Politics
    "diplomacy",
    "foreign policy",
    "embassy",
    "ambassador",
    "sanctions",
    "geopolitics",
    "united nations",
    "un",

    // Security / State Power
    "military",
    "defense",
    "security forces",
    "coup",
    "protest",
    "demonstration",
    "civil unrest",

    // Nigeria-specific (VERY IMPORTANT for your app)
    "inec",
    "nigerian politics",
    "abuja",
    "aso rock",
    "national assembly",
    "apc",
    "pdp",
    "labour party",
    "tinubu",
  ],
  Health: [
    // Your original
    "covid",
    "health",
    "medicine",
    "hospital",
    "vaccine",
    "disease",
    "mental health",
    "fda",

    // General Health Terms
    "healthcare",
    "public health",
    "wellness",
    "medical",
    "clinical",
    "treatment",
    "diagnosis",
    "symptoms",
    "condition",

    // Diseases / Conditions
    "infection",
    "virus",
    "bacteria",
    "outbreak",
    "epidemic",
    "pandemic",
    "cancer",
    "diabetes",
    "malaria",
    "cholera",
    "tuberculosis",
    "hiv",
    "aids",

    // Medicine / Pharma
    "drug",
    "pharmaceutical",
    "pharma",
    "prescription",
    "therapy",
    "clinical trial",
    "trial",
    "medication",

    // Hospitals / Care
    "doctor",
    "nurse",
    "clinic",
    "emergency",
    "surgery",
    "patient",
    "health system",

    // Mental Health Expansion
    "depression",
    "anxiety",
    "stress",
    "therapy",
    "psychology",
    "psychiatry",

    // Fitness / Lifestyle
    "fitness",
    "exercise",
    "nutrition",
    "diet",
    "weight loss",
    "obesity",
    "lifestyle",

    // Policy / Health Agencies
    "who",
    "world health organization",
    "cdc",
    "health ministry",
    "regulation",

    // Nigeria-specific (VERY IMPORTANT for your app)
    "ncdc",
    "nigerian health",
    "abuja hospital",
    "lagos hospital",
    "primary healthcare",
  ],
  World: [
    // Your original
    "war",
    "conflict",
    "international",
    "united nations",
    "diplomacy",
    "sanctions",
    "cease fire",

    // Core World News Terms
    "world",
    "global",
    "international relations",
    "foreign affairs",
    "geopolitics",
    "cross-border",

    // Conflict / Security
    "military",
    "defense",
    "armed forces",
    "battle",
    "invasion",
    "attack",
    "airstrike",
    "missile",
    "troops",
    "violence",

    // Politics (International)
    "foreign policy",
    "summit",
    "treaty",
    "agreement",
    "alliance",
    "nato",
    "eu",
    "african union",
    "au",

    // Migration / Humanitarian
    "refugee",
    "migration",
    "immigration",
    "asylum",
    "displacement",
    "humanitarian",
    "aid",
    "crisis",

    // Disasters / Global Events
    "earthquake",
    "flood",
    "wildfire",
    "hurricane",
    "disaster",
    "emergency",
    "climate",
    "climate change",

    // Economy (Global angle)
    "global economy",
    "oil",
    "energy",
    "gas",
    "supply chain",
    "trade war",

    // Countries / Regions (high signal)
    "usa",
    "china",
    "russia",
    "uk",
    "europe",
    "asia",
    "middle east",
    "africa",

    // International Organizations
    "un",
    "unicef",
    "who",
    "world bank",
    "imf",

    // Misc Global Coverage
    "border",
    "territory",
    "sovereignty",
    "international law",
  ],
  Crypto: [
    // Your original
    "bitcoin",
    "ethereum",

    // Core Crypto Terms
    "crypto",
    "cryptocurrency",
    "blockchain",
    "web3",
    "decentralized",
    "digital asset",

    // Popular Coins / Tokens
    "btc",
    "eth",
    "binance coin",
    "bnb",
    "solana",
    "sol",
    "xrp",
    "ripple",
    "dogecoin",
    "doge",
    "cardano",
    "ada",
    "polygon",
    "matic",
    "tron",
    "trx",

    // Trading / Market Terms
    "crypto market",
    "altcoin",
    "bull run",
    "bear market",
    "price surge",
    "price drop",
    "market cap",
    "trading",
    "exchange",
    "liquidity",
    "volume",

    // Platforms / Companies
    "binance",
    "coinbase",
    "kraken",
    "okx",
    "bybit",

    // DeFi / Web3
    "defi",
    "decentralized finance",
    "staking",
    "yield farming",
    "liquidity pool",
    "smart contract",
    "dao",
    "dapp",

    // NFTs / Metaverse
    "nft",
    "non-fungible token",
    "metaverse",
    "tokenization",

    // Regulation / Security
    "crypto regulation",
    "sec",
    "compliance",
    "ban",
    "fraud",
    "scam",
    "hack",
    "wallet",
    "private key",
    "exchange hack",

    // Mining / Infrastructure
    "mining",
    "miner",
    "hashrate",
    "proof of work",
    "proof of stake",
    "layer 2",
    "scaling",

    // Nigeria / Africa-specific (VERY IMPORTANT)
    "cbn crypto",
    "crypto ban",
    "p2p trading",
    "naira crypto",
    "africa crypto",
  ],
};

// ── Slugify ───────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

// ── Keyword matching helper (word boundary safe without regex rebuild) ───────

function countWordOccurrences(text: string, word: string): number {
  // Simple fast path
  if (!text.includes(word)) return 0;

  // Ensure word boundaries manually
  const pattern = new RegExp(
    `\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    "g",
  );
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

// ── Classify text into a category ────────────────────────────────────────────

function classifyText(text: string): string {
  const lower = text.toLowerCase();

  let bestCategory = "General";
  let bestScore = 0;

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;

    for (const word of keywords) {
      score += countWordOccurrences(lower, word);
    }

    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  return bestCategory;
}

// ── Get or create category ────────────────────────────────────────────────────

export async function detectCategoryId(text: string): Promise<string> {
  const name = classifyText(text);
  const slug = slugify(name);

  // Fast path — category likely already exists
  const [existing] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.name, name))
    .limit(1);

  if (existing) return existing.id;

  // Insert — skip on duplicate (race-safe)
  const [inserted] = await db
    .insert(categories)
    .values({ name, slug })
    .onConflictDoNothing()
    .returning({ id: categories.id });

  if (inserted) return inserted.id;

  // Concurrent insert won the race — re-fetch
  const [retry] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.name, name))
    .limit(1);

  if (retry) return retry.id;

  throw new Error(
    `Failed to get or create category "${name}". ` +
      `Ensure categories.name has a UNIQUE constraint.`,
  );
}
