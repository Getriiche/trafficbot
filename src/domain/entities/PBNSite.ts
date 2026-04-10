/**
 * PBN Site Entity - Represents a site in the Private Blog Network
 * Following hierarchy: Tier3 → Tier2 → Tier1 → MoneySite
 */

export type TierLevel = 'tier3' | 'tier2' | 'tier1' | 'moneysite';

export interface PBNSite {
  id: string;
  name: string;
  url: string;
  tier: TierLevel;
  keywords: string[];
  sitemap?: string; // WordPress sitemap.xml URL
  authority: number; // Domain authority score (0-100)
  niche: string;
  enabled?: boolean; // Whether this site is active (defaults to true)
  
  // Tier-specific properties
  domainType?: 'expired' | 'deleted' | 'emd' | 'new' | 'social' | 'authority';
  backlinks?: string[]; // URLs this site links to
  socialReferrers?: string[]; // For tier3 - which social platforms can link here
  
  // Content configuration
  contentUrls?: string[]; // Specific URLs to visit (alternatives to sitemap)
  preferredKeywords?: string[]; // Keywords this site should rank for
}

export interface FunnelStep {
  tier: TierLevel;
  siteId: string;
  url: string;
  durationSeconds: number;
  referrer?: string; // Previous step URL or social referrer
  referrerType?: 'social' | 'direct' | 'organic' | 'backlink';
  keyword?: string; // Keyword context for this step
  
  // Behavior configuration
  intensity: 'low' | 'medium' | 'high';
  clickProbability: number; // 0-1, chance of clicking internal links
}

export interface FunnelTemplate {
  id: string;
  name: string;
  description: string;
  tierSequence: TierLevel[];
  probability: number; // Weight for random selection
  minSteps: number;
  maxSteps: number;
}

export interface FunnelSession {
  id: string;
  templateId: string;
  steps: FunnelStep[];
  currentStepIndex: number;
  targetKeyword: string;
  startTime: Date;
  
  // Tracking
  completedSteps: string[];
  failedSteps: string[];
  totalDurationMs: number;
}

export interface KeywordMapping {
  keyword: string;
  targetTier3?: string[]; // Site IDs
  targetTier2?: string[];
  targetTier1?: string[];
  targetMoneySite?: string;
  searchVolume?: number;
  competition?: 'low' | 'medium' | 'high';
}

export interface PBNNetwork {
  sites: PBNSite[];
  templates: FunnelTemplate[];
  keywordMappings: KeywordMapping[];
  
  // Site getters by tier
  getSitesByTier(tier: TierLevel): PBNSite[];
  getSitesByKeyword(keyword: string, tier?: TierLevel): PBNSite[];
  getSiteById(id: string): PBNSite | undefined;
  
  // Template operations
  getTemplate(id: string): FunnelTemplate | undefined;
  getRandomTemplate(): FunnelTemplate | null;
  
  // Keyword operations
  getKeywordMapping(keyword: string): KeywordMapping | undefined;
  getKeywordsForSite(siteId: string): string[];
}

/**
 * Custom Funnel Configuration - Define specific URLs for each tier
 * Bypasses the automatic site selection
 */
export interface CustomFunnelStep {
  tier: TierLevel;
  url: string;
  durationSeconds: number;
  keyword?: string;
  intensity?: 'low' | 'medium' | 'high';
  clickProbability?: number;
}

export interface CustomFunnelConfig {
  id: string;
  name: string;
  description?: string;
  targetKeyword: string;
  steps: CustomFunnelStep[];
  
  // Optional referrer chain - if not provided, auto-generated
  customReferrers?: {
    tier3?: string;  // Social referrer for first step
    tier2?: string;  // Should be tier3 URL
    tier1?: string;  // Should be tier2 URL
    moneysite?: string; // Should be tier1 URL
  };
  
  // Session configuration
  proxy?: {
    host: string;
    port: number;
    username?: string;
    password?: string;
  };
  userAgent?: string;
  viewport?: { width: number; height: number };
  
  // Execution settings
  repeatCount?: number; // How many times to run this funnel
  delayBetweenRuns?: number; // Seconds between runs
}
