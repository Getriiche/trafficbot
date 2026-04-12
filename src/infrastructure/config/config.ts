import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config();

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  DEFAULT_URL: z.preprocess((val) => process.env.URL || val, z.string().url()).default('https://lucasveneno.com/'),
  MAX_SESSIONS: z.coerce.number().int().positive().default(1),
  STEALTH_MODE: z.preprocess((a) => a === 'true' || a === '1' || a === true, z.boolean()).default(true),
  HEADLESS: z.preprocess((a) => a === 'false' || a === '0' || a === false ? false : true, z.boolean()).default(true),
  PERSISTENT_SESSIONS: z.preprocess((a) => a === 'true' || a === '1' || a === true, z.boolean()).default(false),
  SESSIONS_DATA_DIR: z.string().default('./sessions'),
  PROXY_URL: z.string().optional(),
  PROXY_PORT: z.coerce.number().optional(),
  PROXY_USER: z.string().optional(),
  PROXY_PASS: z.string().optional(),
  SESSION_TIME: z.coerce.string().default('3'),
  REFERRALS: z.enum(['yes', 'no']).default('no'),
  HUMAN_BEHAVIOR: z.preprocess((a) => a === 'true' || a === '1' || a === true, z.boolean()).default(true),
  BEHAVIOR_INTENSITY: z.enum(['low', 'medium', 'high']).default('medium'),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  BOT_ROLE: z.enum(['producer', 'worker', 'both']).default('both'),
  ORGANIC_SEARCH: z.preprocess((val) => val === 'true', z.boolean()).default(false),
  SEARCH_KEYWORDS: z.preprocess((val) => (val ? String(val).split(',') : []), z.array(z.string())).default([]),
  REFERRER_POOL: z.preprocess((val) => (val ? String(val).split(',') : []), z.array(z.string())).default([]),
  MATCH_GEOLOCATION: z.preprocess((val) => val === 'true', z.boolean()).default(false),
  SEARCH_TARGET_TYPE: z.enum(['url', 'contains', 'text']).default('url'),
  SEARCH_TARGET_VALUE: z.string().optional(),
  SEARCH_PAGES_LIMIT: z.coerce.number().min(1).max(10).default(1),
  SEARCH_ENGINE: z.enum(['google', 'bing', 'duckduckgo', 'random']).default('google'),

  // [PBN Configuration]
  PBN_ENABLED: z.preprocess((val) => val === 'true', z.boolean()).default(false),
  PBN_SITES_CONFIG: z.string().default('./pbn-sites.json'),
  
  // [Private Proxy List - Format: host:port:user:pass per line]
  // Supports session sticky if provider supports it (e.g., _session-{id})
  PROXY_LIST: z.string().optional(), // e.g., "proxy1.com:1234:user:pass\nproxy2.com:1234:user:pass"
  PROXY_FILE: z.string().optional(), // Path to proxy list file
  
  // [IPRoyal Web Unblocker - DEPRECATED: Not compatible with Puppeteer]
  // Kept for backward compatibility but NOT recommended for browser automation
  IPROYAL_HOST: z.string().default('unblocker.iproyal.com'),
  IPROYAL_PORT: z.coerce.number().default(12323),
  IPROYAL_USER: z.string().optional(),
  IPROYAL_PASS: z.string().optional(),
  IPROYAL_COUNTRY: z.string().optional(),
  IPROYAL_STATE: z.string().optional(),
  IPROYAL_CITY: z.string().optional(),
  IPROYAL_RENDER_JS: z.preprocess((a) => a === 'true' || a === '1' || a === true, z.boolean()).default(false)
  
  // [IPCook Proxy Configuration - DEPRECATED, use IPRoyal instead]
  IPCOOK_PROXY_LIST: z.string().optional(),
  IPCOOK_API_AUTH: z.string().optional(),
  IPCOOK_ACCESS_ID: z.string().optional(),
  IPCOOK_SIGN: z.string().optional(),
  IPCOOK_SUB_UID: z.string().optional(),
  IPCOOK_GEO_HOST: z.string().default('geo.ipcook.com'),
  IPCOOK_GEO_PORT: z.coerce.number().default(32345),
  
  // [Hybrid Funnel Configuration - Social + Organic]
  FUNNEL_HYBRID_MODE: z.preprocess((val) => val === 'true', z.boolean()).default(false), // Enable both social + organic
  FUNNEL_ORGANIC_PROBABILITY: z.coerce.number().min(0).max(1).default(0.4), // 40% Organic, 60% Social
  FUNNEL_TEMPLATES: z.preprocess((val) => (val ? String(val).split(',') : []), z.array(z.string())).default(['tier3-tier2-tier1-money', 'tier3-tier1-money', 'tier2-tier1-money']),
  TIER3_DURATION_MIN: z.coerce.number().default(60),
  TIER3_DURATION_MAX: z.coerce.number().default(180),
  TIER2_DURATION_MIN: z.coerce.number().default(120),
  TIER2_DURATION_MAX: z.coerce.number().default(300),
  TIER1_DURATION_MIN: z.coerce.number().default(90),
  TIER1_DURATION_MAX: z.coerce.number().default(240),
  // [Multi-Site Configuration]
  MONEYSITE_URLS: z.preprocess((val) => (val ? String(val).split(',') : []), z.array(z.string().url())).default([]),
  MONEYSITE_DURATION_MIN: z.coerce.number().default(90),   // 90s minimum par visite
  MONEYSITE_DURATION_MAX: z.coerce.number().default(350), // 350s maximum par visite
  MAX_CONCURRENT_SITES: z.coerce.number().min(1).max(5).default(2), // 2 sites en parallèle
  // Social referrers for Tier3
  TIER3_SOCIAL_PLATFORMS: z.preprocess((val) => (val ? String(val).split(',') : ['reddit,medium,quora,facebook,twitter']), z.array(z.string())).default(['reddit', 'medium', 'quora']),
  // Distribution weights
  TIER3_WEIGHT: z.coerce.number().default(0.3),
  TIER2_WEIGHT: z.coerce.number().default(0.25),
  TIER1_WEIGHT: z.coerce.number().default(0.25),
  MONEYSITE_WEIGHT: z.coerce.number().default(0.2),
});

export const Config = ConfigSchema.parse(process.env);
export type ConfigType = z.infer<typeof ConfigSchema>;