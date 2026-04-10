import { logger } from '../logging/logger';
import { Config } from '../config/config';
import { sitemapParser } from './SitemapParserService';
import { 
  PBNSite, 
  FunnelStep, 
  FunnelTemplate, 
  FunnelSession, 
  TierLevel,
  KeywordMapping,
  PBNNetwork as PBNNetworkInterface,
  CustomFunnelConfig,
  CustomFunnelStep
} from '../../domain/entities/PBNSite';

/**
 * FunnelPlannerService - Plans PBN traffic funnels
 * Hierarchy: Tier3 (Social/External) → Tier2 (Expired) → Tier1 (EMD/New) → MoneySite
 */
export class FunnelPlannerService implements PBNNetworkInterface {
  sites: PBNSite[] = [];
  templates: FunnelTemplate[] = [];
  keywordMappings: KeywordMapping[] = [];

  // Social platforms for Tier3 referrers
  private readonly socialReferrers: Record<string, { base: string; paths: string[] }> = {
    reddit: { 
      base: 'https://www.reddit.com', 
      paths: ['/r/SEO/', '/r/affiliatemarketing/', '/r/passiveincome/', '/r/digitalmarketing/'] 
    },
    medium: { 
      base: 'https://medium.com', 
      paths: ['/tag/seo', '/tag/affiliate-marketing', '/tag/digital-marketing', '/search?q=niche+sites'] 
    },
    quora: { 
      base: 'https://www.quora.com', 
      paths: ['/topic/Search-Engine-Optimization-SEO', '/topic/Affiliate-Marketing', '/What-is-the-best-SEO-strategy'] 
    },
    facebook: { 
      base: 'https://www.facebook.com', 
      paths: ['/groups/seomarketing', '/groups/affiliatemarketers'] 
    },
    twitter: { 
      base: 'https://twitter.com', 
      paths: ['/search?q=seo', '/search?q=affiliate+marketing'] 
    },
    pinterest: { 
      base: 'https://www.pinterest.com', 
      paths: ['/search/pins/?q=seo', '/search/pins/?q=affiliate+marketing'] 
    }
  };

  constructor() {
    this.loadFromConfig();
  }

  /**
   * Load PBN configuration from JSON file
   */
  private loadFromConfig(): void {
    try {
      const fs = require('fs');
      const path = require('path');
      const configPath = path.resolve(Config.PBN_SITES_CONFIG);
      
      if (fs.existsSync(configPath)) {
        const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        this.sites = data.sites || [];
        this.templates = data.templates || [];
        this.keywordMappings = data.keywordMappings || [];
        
        logger.info('PBN configuration loaded', { 
          sites: this.sites.length, 
          templates: this.templates.length,
          keywords: this.keywordMappings.length 
        });
      } else {
        logger.warn('PBN config file not found, using defaults', { path: configPath });
        this.initializeDefaults();
      }
    } catch (error) {
      logger.error('Failed to load PBN config', { error });
      this.initializeDefaults();
    }
  }

  /**
   * Initialize default minimal configuration
   */
  private initializeDefaults(): void {
    this.templates = [
      {
        id: 'full-funnel',
        name: 'Complete PBN Funnel',
        description: 'Tier3 → Tier2 → Tier1 → MoneySite',
        tierSequence: ['tier3', 'tier2', 'tier1', 'moneysite'],
        probability: 0.4,
        minSteps: 4,
        maxSteps: 4
      },
      {
        id: 'social-to-money',
        name: 'Direct Social',
        description: 'Tier3 → MoneySite',
        tierSequence: ['tier3', 'moneysite'],
        probability: 0.15,
        minSteps: 2,
        maxSteps: 2
      },
      {
        id: 'tier3-tier1-money',
        name: 'Social to EMD',
        description: 'Tier3 → Tier1 → MoneySite',
        tierSequence: ['tier3', 'tier1', 'moneysite'],
        probability: 0.25,
        minSteps: 3,
        maxSteps: 3
      },
      {
        id: 'tier2-tier1-money',
        name: 'Expired to EMD',
        description: 'Tier2 → Tier1 → MoneySite',
        tierSequence: ['tier2', 'tier1', 'moneysite'],
        probability: 0.2,
        minSteps: 3,
        maxSteps: 3
      }
    ];
  }

  // ============ Site Management ============

  getSitesByTier(tier: TierLevel): PBNSite[] {
    return this.sites.filter(s => s.tier === tier && s.enabled !== false);
  }

  getSitesByKeyword(keyword: string, tier?: TierLevel): PBNSite[] {
    const keywordLower = keyword.toLowerCase();
    let filtered = this.sites.filter(s => 
      s.enabled !== false && 
      s.keywords.some(k => k.toLowerCase().includes(keywordLower))
    );
    if (tier) {
      filtered = filtered.filter(s => s.tier === tier);
    }
    return filtered;
  }

  getSiteById(id: string): PBNSite | undefined {
    return this.sites.find(s => s.id === id);
  }

  // ============ Template Management ============

  getTemplate(id: string): FunnelTemplate | undefined {
    return this.templates.find(t => t.id === id);
  }

  getRandomTemplate(): FunnelTemplate | null {
    if (this.templates.length === 0) return null;
    
    const totalProbability = this.templates.reduce((sum, t) => sum + t.probability, 0);
    let random = Math.random() * totalProbability;
    
    for (const template of this.templates) {
      random -= template.probability;
      if (random <= 0) {
        return template;
      }
    }
    
    return this.templates[this.templates.length - 1];
  }

  // ============ Keyword Management ============

  getKeywordMapping(keyword: string): KeywordMapping | undefined {
    return this.keywordMappings.find(k => 
      k.keyword.toLowerCase() === keyword.toLowerCase()
    );
  }

  getKeywordsForSite(siteId: string): string[] {
    const site = this.getSiteById(siteId);
    return site?.keywords || [];
  }

  // ============ Funnel Planning ============

  /**
   * Plan a complete funnel for a keyword
   */
  async planFunnel(keyword: string, templateOverride?: string): Promise<FunnelSession | null> {
    const template = templateOverride 
      ? this.getTemplate(templateOverride)
      : this.getRandomTemplate();

    if (!template) {
      logger.error('No funnel template available');
      return null;
    }

    const mapping = this.getKeywordMapping(keyword);
    const steps: FunnelStep[] = [];

    for (let i = 0; i < template.tierSequence.length; i++) {
      const tier = template.tierSequence[i];
      const step = await this.createStep(tier, keyword, mapping, steps[i - 1], i);
      
      if (step) {
        steps.push(step);
      } else {
        logger.warn(`Could not create step for tier: ${tier}, keyword: ${keyword}`);
        // Continue with partial funnel if possible
        if (tier === 'moneysite' && steps.length > 0) {
          break; // Must have money site, but we don't - fail
        }
      }
    }

    if (steps.length === 0) {
      logger.error('No steps could be planned for funnel', { keyword, template: template.id });
      return null;
    }

    const session: FunnelSession = {
      id: `funnel-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      templateId: template.id,
      steps,
      currentStepIndex: 0,
      targetKeyword: keyword,
      startTime: new Date(),
      completedSteps: [],
      failedSteps: [],
      totalDurationMs: 0
    };

    logger.info('Funnel planned', { 
      sessionId: session.id, 
      template: template.name,
      keyword,
      steps: steps.length,
      tiers: template.tierSequence.join(' → ')
    });

    return session;
  }

  /**
   * Create a single funnel step
   */
  private async createStep(
    tier: TierLevel, 
    keyword: string,
    mapping: KeywordMapping | undefined,
    previousStep: FunnelStep | undefined,
    stepIndex: number
  ): Promise<FunnelStep | null> {
    // Get sites for this tier
    let targetSites: PBNSite[] = [];
    
    if (mapping) {
      const siteIds = this.getSiteIdsForTier(mapping, tier);
      targetSites = siteIds
        .map(id => this.getSiteById(id))
        .filter((s): s is PBNSite => s !== undefined && s.enabled !== false);
    }
    
    // Fallback: find by keyword
    if (targetSites.length === 0) {
      targetSites = this.getSitesByKeyword(keyword, tier);
    }
    
    // Last fallback: any site in tier
    if (targetSites.length === 0) {
      targetSites = this.getSitesByTier(tier);
    }

    if (targetSites.length === 0) {
      logger.warn(`No sites available for tier: ${tier}`);
      return null;
    }

    // Select site (weighted by authority for tier2/3, random for tier1)
    const site = this.selectSite(targetSites, tier);
    
    // Determine URL - Use sitemap if available, fallback to contentUrls
    let url = site.url;
    
    if (site.sitemap) {
      // Fetch random URL from sitemap for variety
      const sitemapUrl = await sitemapParser.getRandomUrl(site.sitemap);
      if (sitemapUrl) {
        url = sitemapUrl;
        logger.debug('Using sitemap URL', { site: site.id, url });
      }
    } else if (site.contentUrls && site.contentUrls.length > 0) {
      // Fallback to static contentUrls
      url = site.contentUrls[Math.floor(Math.random() * site.contentUrls.length)];
    }

    // Determine referrer - Hybrid mode: Social OR Organic
    let referrer: string | undefined;
    let referrerType: FunnelStep['referrerType'] = 'direct';

    if (stepIndex === 0) {
      // First step - choose between social referrer or organic search
      if (tier === 'tier3' || (Config.FUNNEL_HYBRID_MODE && tier === 'tier2')) {
        const useOrganic = Config.FUNNEL_HYBRID_MODE && Math.random() < Config.FUNNEL_ORGANIC_PROBABILITY;
        
        if (useOrganic) {
          // Use organic search as entry point
          referrer = this.getOrganicSearchUrl(keyword);
          referrerType = 'organic';
          logger.debug('Using organic search as funnel entry', { keyword, tier });
        } else {
          // Use social referrer
          const social = this.generateSocialReferrer(keyword);
          referrer = social.referrer;
          referrerType = social.type;
        }
      }
    } else if (previousStep) {
      // Subsequent steps - backlink from previous
      referrer = previousStep.url;
      referrerType = 'backlink';
    }

    // Duration based on tier config
    const duration = this.getDurationForTier(tier);

    return {
      tier,
      siteId: site.id,
      url,
      durationSeconds: duration,
      referrer,
      referrerType,
      keyword,
      intensity: this.getIntensityForTier(tier),
      clickProbability: tier === 'tier2' ? 0.7 : tier === 'tier1' ? 0.8 : 0.6
    };
  }

  /**
   * Get site IDs from keyword mapping for specific tier
   */
  private getSiteIdsForTier(mapping: KeywordMapping, tier: TierLevel): string[] {
    switch (tier) {
      case 'tier3': return mapping.targetTier3 || [];
      case 'tier2': return mapping.targetTier2 || [];
      case 'tier1': return mapping.targetTier1 || [];
      case 'moneysite': return mapping.targetMoneySite ? [mapping.targetMoneySite] : [];
    }
  }

  /**
   * Select site with tier-appropriate weighting
   */
  private selectSite(sites: PBNSite[], tier: TierLevel): PBNSite {
    if (sites.length === 1) return sites[0];

    // For tier2, prefer higher authority expired domains
    if (tier === 'tier2') {
      const sorted = [...sites].sort((a, b) => b.authority - a.authority);
      return sorted[0]; // Pick highest authority
    }

    // For others, weighted random
    const totalWeight = sites.reduce((sum, s) => sum + s.authority, 0);
    let random = Math.random() * totalWeight;
    
    for (const site of sites) {
      random -= site.authority;
      if (random <= 0) return site;
    }
    
    return sites[sites.length - 1];
  }

  /**
   * Get organic search URL for keyword
   */
  private getOrganicSearchUrl(keyword: string): string {
    const encoded = encodeURIComponent(keyword);
    const engines = [
      `https://www.google.com/search?q=${encoded}`,
      `https://www.bing.com/search?q=${encoded}`,
      `https://duckduckgo.com/?q=${encoded}`
    ];
    return engines[Math.floor(Math.random() * engines.length)];
  }

  /**
   * Generate social referrer for Tier3 entry
   */
  private generateSocialReferrer(keyword: string): { referrer: string; type: 'social' | 'direct' } {
    const platforms = Config.TIER3_SOCIAL_PLATFORMS;
    const platform = platforms[Math.floor(Math.random() * platforms.length)];
    const config = this.socialReferrers[platform];
    
    let path = '';
    if (config) {
      path = config.paths[Math.floor(Math.random() * config.paths.length)];
    }
    
    // Build realistic referrer
    const base = config?.base || `https://www.${platform}.com`;
    const referrer = `${base}${path}`;
    
    logger.debug('Generated social referrer', { platform, referrer, keyword });
    
    return { referrer, type: 'social' };
  }

  /**
   * Get duration range for tier
   */
  private getDurationForTier(tier: TierLevel): number {
    const ranges: Record<TierLevel, { min: number; max: number }> = {
      tier3: { min: Config.TIER3_DURATION_MIN, max: Config.TIER3_DURATION_MAX },
      tier2: { min: Config.TIER2_DURATION_MIN, max: Config.TIER2_DURATION_MAX },
      tier1: { min: Config.TIER1_DURATION_MIN, max: Config.TIER1_DURATION_MAX },
      moneysite: { min: Config.MONEYSITE_DURATION_MIN, max: Config.MONEYSITE_DURATION_MAX }
    };
    
    const range = ranges[tier];
    return Math.floor(Math.random() * (range.max - range.min) + range.min);
  }

  /**
   * Get behavior intensity for tier
   */
  private getIntensityForTier(tier: TierLevel): 'low' | 'medium' | 'high' {
    // More engagement on lower tiers, focused on money site
    switch (tier) {
      case 'tier3': return 'low';
      case 'tier2': return 'medium';
      case 'tier1': return 'high';
      case 'moneysite': return 'high';
    }
  }

  /**
   * Plan a custom funnel with specific URLs for each tier
   * Bypasses automatic site selection
   */
  planCustomFunnel(config: CustomFunnelConfig): FunnelSession | null {
    try {
      const steps: FunnelStep[] = [];
      
      for (let i = 0; i < config.steps.length; i++) {
        const customStep = config.steps[i];
        const previousStep = steps[i - 1];
        
        // Determine referrer
        let referrer: string | undefined;
        let referrerType: FunnelStep['referrerType'] = 'direct';
        
        if (i === 0) {
          // First step - use custom referrer if provided, or generate social for tier3
          if (customStep.tier === 'tier3') {
            if (config.customReferrers?.tier3) {
              referrer = config.customReferrers.tier3;
              referrerType = 'social';
            } else {
              const social = this.generateSocialReferrer(config.targetKeyword);
              referrer = social.referrer;
              referrerType = social.type;
            }
          }
        } else if (previousStep) {
          // Chain from previous step
          referrer = previousStep.url;
          referrerType = 'backlink';
          
          // Override with custom referrer if provided
          if (config.customReferrers) {
            const tierToRef: Record<TierLevel, keyof typeof config.customReferrers> = {
              'tier3': 'tier3',
              'tier2': 'tier2',
              'tier1': 'tier1',
              'moneysite': 'moneysite'
            };
            const customRefKey = tierToRef[customStep.tier];
            if (customRefKey && config.customReferrers[customRefKey]) {
              referrer = config.customReferrers[customRefKey];
            }
          }
        }
        
        const step: FunnelStep = {
          tier: customStep.tier,
          siteId: `custom-${customStep.tier}-${i}`,
          url: customStep.url,
          durationSeconds: customStep.durationSeconds,
          referrer,
          referrerType,
          keyword: customStep.keyword || config.targetKeyword,
          intensity: customStep.intensity || this.getIntensityForTier(customStep.tier),
          clickProbability: customStep.clickProbability || (customStep.tier === 'moneysite' ? 0.8 : 0.6)
        };
        
        steps.push(step);
      }
      
      if (steps.length === 0) {
        logger.error('Custom funnel has no steps', { configId: config.id });
        return null;
      }
      
      const session: FunnelSession = {
        id: `custom-funnel-${config.id}-${Date.now()}`,
        templateId: 'custom',
        steps,
        currentStepIndex: 0,
        targetKeyword: config.targetKeyword,
        startTime: new Date(),
        completedSteps: [],
        failedSteps: [],
        totalDurationMs: 0
      };
      
      logger.info('Custom funnel planned', {
        sessionId: session.id,
        name: config.name,
        keyword: config.targetKeyword,
        steps: steps.length,
        tiers: steps.map(s => s.tier).join(' → ')
      });
      
      return session;
      
    } catch (error) {
      logger.error('Failed to plan custom funnel', { 
        configId: config.id,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Plan multiple funnels for batch processing
   */
  async planBatchFunnels(keywords: string[], sessionsPerKeyword: number = 1): Promise<FunnelSession[]> {
    const sessions: FunnelSession[] = [];
    
    for (const keyword of keywords) {
      for (let i = 0; i < sessionsPerKeyword; i++) {
        const session = await this.planFunnel(keyword);
        if (session) {
          sessions.push(session);
        }
      }
    }
    
    logger.info('Batch funnel planning complete', { 
      keywords: keywords.length,
      requested: keywords.length * sessionsPerKeyword,
      planned: sessions.length 
    });
    
    return sessions;
  }

  /**
   * Get statistics
   */
  getStats(): {
    sites: number;
    sitesByTier: Record<TierLevel, number>;
    templates: number;
    keywords: number;
  } {
    return {
      sites: this.sites.length,
      sitesByTier: {
        tier3: this.getSitesByTier('tier3').length,
        tier2: this.getSitesByTier('tier2').length,
        tier1: this.getSitesByTier('tier1').length,
        moneysite: this.getSitesByTier('moneysite').length
      },
      templates: this.templates.length,
      keywords: this.keywordMappings.length
    };
  }
}

// Singleton instance for global access
export const funnelPlanner = new FunnelPlannerService();
