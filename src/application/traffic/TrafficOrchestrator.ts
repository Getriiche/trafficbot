import { BrowserEngine, BrowserOptions } from '../../domain/interfaces/BrowserEngine';
import { Session } from '../../domain/entities/Session';
import { FunnelSession, FunnelStep, PBNSite } from '../../domain/entities/PBNSite';
import { logger } from '../../infrastructure/logging/logger';
import { Config } from '../../infrastructure/config/config';
import { BehaviorService } from '../../infrastructure/browser/BehaviorService';
import { MetricsService } from '../../infrastructure/monitoring/MetricsService';
import { ReputationService } from '../../infrastructure/monitoring/ReputationService';
import { funnelPlanner } from '../../infrastructure/pbn/FunnelPlannerService';

export class TrafficOrchestrator {
  private blacklist = [
    'https://www.facebook.com/ppplayermusic',
    'https://instagram.com/ppplayermusic',
    'https://lucasveneno.com/public/search',
    'https://lucasveneno.com/search',
    'https://lucasveneno.com/login',
    'https://lucasveneno.com/register'
  ];

  constructor(private engine: BrowserEngine) {}

  async run(session: Session, options: Partial<BrowserOptions> = {}): Promise<void> {
    const { config } = session;
    const startTime = Date.now();
    logger.info('Starting traffic session', { 
      id: config.id, 
      url: config.url, 
      targetDurationMs: config.durationMs 
    });

    try {
      const metrics = MetricsService.getInstance();
      metrics.trackSessionStart();

      // Check Proxy Reputation (Optional/Async)
      ReputationService.checkIP(config.proxy?.server).catch((e: Error) => logger.debug('IP check deferred', { e }));

      const { ReferrerService } = require('../../infrastructure/browser/ReferrerService');
      const referrerService = new ReferrerService(logger);

      await this.engine.init({
        userAgent: config.userAgent,
        viewport: config.viewport,
        proxy: config.proxy,
        userDataDir: config.userDataDir,
        headless: options.headless,
        platform: options.platform,
        fingerprintScript: options.fingerprintScript
      });

      // 1. Geolocation Matching (disabled for IPRoyal - proxy handles geo-targeting)
      // IPRoyal Web Unblocker automatically handles geo-location via _country-XX password suffix
      // For legacy proxies, this would require checking IP first (skipped to avoid detection)

      // 2. Organic Search or Referrer Spoofing
      if (Config.ORGANIC_SEARCH && Config.SEARCH_KEYWORDS.length > 0) {
        const keyword = referrerService.getRandomKeyword(Config.SEARCH_KEYWORDS);
        const { name, url: homepageUrl } = referrerService.getSearchHomepage(Config.SEARCH_ENGINE);
        
        logger.info(`Simulating Organic Search via ${name} (Human-like typing)`, { keyword, homepageUrl });
        await this.engine.navigate(homepageUrl);
        await this.engine.waitForNetworkIdle();
        
        // Clear potential consent popups before interacting
        await this.engine.handleConsentPopups();
        
        await this.engine.randomDelay(1000, 3000);
        
        // Type the keyword and search
        await this.engine.searchKeyword(keyword);
        const searchUrl = await this.engine.evaluate(() => window.location.href);
        
        // Wait to simulate "looking" at results
        if (Config.HUMAN_BEHAVIOR) {
          logger.info('Simulating human-like result scanning (scrolling and mouse movement)...');
          const searchWait = Math.floor(Math.random() * 3000) + 3000; // 3-6 seconds
          const searchStart = Date.now();
          while (Date.now() - searchStart < searchWait) {
            await BehaviorService.simulateRandomAction(this.engine, config.viewport, { intensity: 'low' });
          }
        } else {
          logger.info('Waiting briefly on search results...');
          await this.engine.randomDelay(2000, 5000);
        }

        // Targeted Clicking Logic (Multi-page loop)
        // Get target from PBN sites if SEARCH_TARGET_VALUE not set
        let targetValue = Config.SEARCH_TARGET_VALUE;
        if (!targetValue) {
          // Get all enabled PBN sites and pick one randomly
          const allSites = [
            ...funnelPlanner.getSitesByTier('tier2'),
            ...funnelPlanner.getSitesByTier('tier1'),
            ...funnelPlanner.getSitesByTier('moneysite')
          ].filter((s): s is PBNSite => s && s.enabled !== false);
          
          if (allSites.length > 0) {
            const randomSite = allSites[Math.floor(Math.random() * allSites.length)];
            targetValue = randomSite.url;
            logger.info('Selected random PBN site for organic search', { 
              site: randomSite.id, 
              url: randomSite.url,
              tier: randomSite.tier 
            });
          } else {
            targetValue = config.url;
          }
        }
        
        const targetType = Config.SEARCH_TARGET_TYPE;
        const pageLimit = Config.SEARCH_PAGES_LIMIT;
        
        let clicked = false;
        for (let page = 1; page <= pageLimit; page++) {
          logger.info(`Searching for target link (Page ${page}/${pageLimit})...`, { 
            strategy: targetType, 
            pattern: targetValue 
          });

          clicked = await this.engine.clickSearchResult(targetValue);

          if (clicked) {
            logger.info(`Successfully identified and clicked target search result on page ${page}!`);
            // Wait for navigation to commence and network to settle
            await this.engine.wait(Math.floor(Math.random() * 2000) + 3000); 
            try {
              await this.engine.waitForNetworkIdle();
            } catch (e) {
              // Ignore network idle timeout, proceed with the loop
            }
            break;
          }

          if (page < pageLimit) {
            logger.info(`Target not found on page ${page}. Attempting to navigate to next page...`);
            const movedToNext = await this.engine.clickNextSearchPage();
            if (!movedToNext) {
              logger.warn(`Could not find "Next" button on search page ${page}. Stopping search.`);
              break;
            }
            await this.engine.waitForNetworkIdle();
            // Random delay after clicking next
            await this.engine.randomDelay(2000, 4000);
          }
        }

        if (!clicked) {
          logger.warn(`Target link matching "${targetValue}" not found within ${pageLimit} pages. Navigating directly.`, { 
            type: targetType, 
            value: targetValue 
          });
          // Fallback: Navigate directly but keep referer if possible
          await this.engine.setExtraHeaders({ 'Referer': searchUrl });
          await this.engine.navigate(config.url);
        }
      } else {
        const referrer = referrerService.getRandomReferrer(Config.REFERRER_POOL);
        if (referrer) {
          logger.info(`Spoofing Referrer`, { referrer });
          await this.engine.setExtraHeaders({ 'Referer': referrer });
        }
        await this.engine.navigate(config.url);
      }
      
      // Execute 4 steps with randomized "Thinking Heatmaps" (non-linear stay times)
      const numSteps = 4;
      const totalLoopTime = Math.floor(config.durationMs * 0.8); // Reserve 20% for overhead/final wait
      
      // Generate randomized stay durations that sum to totalLoopTime
      const stayWeights = Array.from({ length: numSteps }, () => Math.random() + 0.5);
      const totalWeight = stayWeights.reduce((a, b) => a + b, 0);
      const stayDurations = stayWeights.map(w => Math.floor((w / totalWeight) * totalLoopTime));

      logger.debug('Starting navigation loop with Thinking Heatmaps', { 
        stayDurations, 
        humanBehavior: Config.HUMAN_BEHAVIOR 
      });
      
      for (let i = 0; i < numSteps; i++) {
        const currentStay = stayDurations[i];
        logger.info(`Step ${i+1}/${numSteps}: Staying for ${currentStay}ms...`);
        
        if (Config.HUMAN_BEHAVIOR) {
          const stepStart = Date.now();
          while (Date.now() - stepStart < currentStay) {
            await BehaviorService.simulateRandomAction(
              this.engine, 
              config.viewport, 
              { intensity: Config.BEHAVIOR_INTENSITY }
            );
          }
        } else {
          await this.engine.wait(currentStay);
        }

        await this.performContextualClick();
      }

      // Final wait to ensure total session duration matches target
      const remainingTime = config.durationMs - (Date.now() - startTime);
      if (remainingTime > 0) {
        logger.debug(`Final compensating wait: ${remainingTime}ms...`);
        await this.engine.wait(remainingTime);
      }
      
      const actualDuration = Date.now() - startTime;
      metrics.trackSessionEnd(true, actualDuration);
      logger.info('Session completed successfully', { 
        id: config.id, 
        actualDurationMs: actualDuration,
        targetDurationMs: config.durationMs
      });
    } catch (error: any) {
      const actualDuration = Date.now() - startTime;
      MetricsService.getInstance().trackSessionEnd(false, actualDuration);
      logger.error('Session execution failed', { 
        id: config.id, 
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name
        } : (typeof error === 'object' ? JSON.stringify(error) : String(error))
      });
    } finally {
      await this.engine.close();
    }
  }

  /**
   * Helper to run a session from a simplified Job Data structure
   */
  async runFromJob(jobId: string, data: any): Promise<void> {
    const { FingerprintService } = require('../../infrastructure/browser/FingerprintService');
    const fingerprint = FingerprintService.generate();
    
    const session = new Session({
      id: jobId,
      url: data.url,
      userAgent: fingerprint.userAgent,
      viewport: fingerprint.viewport,
      durationMs: data.durationMinutes * 60000,
      proxy: data.proxy ? {
        server: `${data.proxy.host}:${data.proxy.port}`,
        username: data.proxy.username,
        password: data.proxy.password
      } : undefined
    });

    await this.run(session, {
      headless: Config.HEADLESS,
      platform: fingerprint.platform,
      fingerprintScript: FingerprintService.getInjectionScript(fingerprint)
    });
  }

  /**
   * Execute a PBN funnel session through multiple tiers
   * Tier3 (Social) → Tier2 (Expired) → Tier1 (EMD) → MoneySite
   */
  async runFunnel(
    funnelSession: FunnelSession,
    options: Partial<BrowserOptions> = {}
  ): Promise<void> {
    const { FingerprintService } = require('../../infrastructure/browser/FingerprintService');
    const fingerprint = FingerprintService.generate();
    
    const sessionStartTime = Date.now();
    logger.info('Starting PBN funnel execution', {
      funnelId: funnelSession.id,
      template: funnelSession.templateId,
      keyword: funnelSession.targetKeyword,
      steps: funnelSession.steps.length,
      tiers: funnelSession.steps.map(s => s.tier).join(' → ')
    });

    try {
      const metrics = MetricsService.getInstance();
      metrics.trackSessionStart();

      logger.info('[DEBUG] Initializing browser engine for funnel', {
        userAgent: fingerprint.userAgent.substring(0, 50) + '...',
        viewport: fingerprint.viewport,
        headless: options.headless ?? Config.HEADLESS
      });

      // Initialize browser once for entire funnel
      await this.engine.init({
        userAgent: fingerprint.userAgent,
        viewport: fingerprint.viewport,
        proxy: options.proxy,
        userDataDir: options.userDataDir,
        headless: options.headless ?? Config.HEADLESS,
        platform: fingerprint.platform,
        fingerprintScript: FingerprintService.getInjectionScript(fingerprint)
      });

      logger.info('[DEBUG] Browser initialized, starting funnel steps', { totalSteps: funnelSession.steps.length });

      // Execute each step of the funnel
      for (let i = 0; i < funnelSession.steps.length; i++) {
        const step = funnelSession.steps[i];
        funnelSession.currentStepIndex = i;

        logger.info('[DEBUG] Executing funnel step', {
          stepIndex: i,
          tier: step.tier,
          siteId: step.siteId,
          url: step.url
        });

        await this.executeFunnelStepWithRetry(step, i, fingerprint.viewport, 2);
        
        // Mark as completed
        funnelSession.completedSteps.push(step.siteId);
        
        // Delay between steps (except last)
        if (i < funnelSession.steps.length - 1) {
          const delay = Math.floor(Math.random() * 3000) + 2000; // 2-5s
          logger.debug(`Delaying ${delay}ms between funnel steps`);
          await this.engine.wait(delay);
        }
      }

      const totalDuration = Date.now() - sessionStartTime;
      funnelSession.totalDurationMs = totalDuration;
      
      metrics.trackSessionEnd(true, totalDuration);
      
      logger.info('PBN funnel completed successfully', {
        funnelId: funnelSession.id,
        stepsCompleted: funnelSession.completedSteps.length,
        totalDuration: Math.round(totalDuration / 1000),
        keyword: funnelSession.targetKeyword
      });

    } catch (error) {
      const failedDuration = Date.now() - sessionStartTime;
      MetricsService.getInstance().trackSessionEnd(false, failedDuration);
      
      logger.error('[DEBUG] PBN funnel execution FAILED', {
        funnelId: funnelSession.id,
        stepIndex: funnelSession.currentStepIndex,
        keyword: funnelSession.targetKeyword,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      
      throw error;
    } finally {
      await this.engine.close();
    }
  }

  /**
   * Execute a single funnel step with retry logic
   * Implements exponential backoff for transient failures
   */
  private async executeFunnelStepWithRetry(
    step: FunnelStep,
    stepIndex: number,
    viewport: { width: number; height: number },
    maxRetries: number = 2
  ): Promise<void> {
    let lastError: Error | null = null;
    
    logger.info('[DEBUG] Starting funnel step with retry logic', {
      tier: step.tier,
      siteId: step.siteId,
      url: step.url,
      maxRetries
    });

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // Exponential backoff: 2s, 4s, 8s...
          const backoffDelay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
          logger.warn(`[DEBUG] Retrying funnel step after failure`, {
            tier: step.tier,
            siteId: step.siteId,
            attempt,
            maxRetries,
            backoffMs: Math.round(backoffDelay),
            lastError: lastError?.message
          });
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
        }
        
        logger.info('[DEBUG] Attempting funnel step execution', { attempt: attempt + 1, maxRetries: maxRetries + 1 });
        return await this.executeFunnelStep(step, stepIndex, viewport);
        
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // Log failure but don't throw yet (will retry)
        logger.error(`[DEBUG] Funnel step attempt ${attempt + 1} FAILED`, {
          tier: step.tier,
          siteId: step.siteId,
          url: step.url,
          attempt: attempt + 1,
          error: lastError.message,
          errorType: error instanceof Error ? error.constructor.name : typeof error
        });
        
        // Don't retry on certain fatal errors (e.g., invalid URL)
        if (lastError.message.includes('invalid url') || lastError.message.includes('protocol')) {
          throw lastError;
        }
      }
    }
    
    // All retries exhausted
    throw lastError || new Error(`Funnel step failed after ${maxRetries + 1} attempts`);
  }

  /**
   * Execute a single funnel step
   */
  private async executeFunnelStep(
    step: FunnelStep,
    stepIndex: number,
    viewport: { width: number; height: number }
  ): Promise<void> {
    const stepStartTime = Date.now();
    
    logger.info(`Executing funnel step ${stepIndex + 1}`, {
      tier: step.tier,
      siteId: step.siteId,
      url: step.url,
      referrer: step.referrer,
      referrerType: step.referrerType,
      duration: step.durationSeconds
    });

    try {
      logger.info('[DEBUG] Starting funnel step execution', {
        stepIndex,
        url: step.url,
        tier: step.tier,
        hasReferrer: !!step.referrer
      });

      // Set referrer header if specified
      if (step.referrer) {
        logger.info('[DEBUG] Setting referrer headers', { referrer: step.referrer, type: step.referrerType });
        await this.engine.setExtraHeaders({ 
          'Referer': step.referrer,
          ...(step.referrerType === 'social' ? { 
            'Origin': new URL(step.referrer).origin 
          } : {})
        });
        
        logger.debug(`Set ${step.referrerType} referrer`, { referrer: step.referrer });
      }

      logger.info('[DEBUG] Navigating to URL', { url: step.url });
      // Navigate to target URL
      await this.engine.navigate(step.url);
      logger.info('[DEBUG] Navigation completed, waiting for network idle', { url: step.url });
      await this.engine.waitForNetworkIdle();
      logger.info('[DEBUG] Network idle reached', { url: step.url });

      // Spoof document.referrer in JavaScript (some sites check this in addition to HTTP header)
      if (step.referrer) {
        await this.engine.evaluate((fakeReferrer) => {
          // Override document.referrer property
          Object.defineProperty(document, 'referrer', {
            get() { return fakeReferrer; },
            configurable: true
          });
          
          // Also override window.history for consistency
          const originalPushState = history.pushState;
          history.pushState = function(...args) {
            const result = originalPushState.apply(this, args);
            Object.defineProperty(document, 'referrer', {
              get() { return fakeReferrer; },
              configurable: true
            });
            return result;
          };
        }, step.referrer);
        
        logger.debug('Injected document.referrer spoofing', { referrer: step.referrer });
      }

      // Handle consent popups
      logger.info('[DEBUG] Handling consent popups');
      await this.engine.handleConsentPopups();
      logger.info('[DEBUG] Consent popups handled');

      // Execute behavior for step duration
      const targetDuration = step.durationSeconds * 1000;
      const behaviorLoops = 4;
      const timePerLoop = targetDuration * 0.8 / behaviorLoops;

      logger.info('[DEBUG] Starting behavior simulation loops', { loops: behaviorLoops, timePerLoop });
      for (let loop = 0; loop < behaviorLoops; loop++) {
        const loopStart = Date.now();
        logger.info('[DEBUG] Starting behavior loop', { loop: loop + 1, of: behaviorLoops });
        
        // Simulate human behavior
        while (Date.now() - loopStart < timePerLoop) {
          await BehaviorService.simulateRandomAction(
            this.engine,
            viewport,
            { intensity: step.intensity }
          );
        }

        // Try contextual click (weighted by clickProbability)
        if (loop < behaviorLoops - 1 && Math.random() < step.clickProbability) {
          logger.info('[DEBUG] Performing contextual click');
          await this.performContextualClick();
        }
      }
      logger.info('[DEBUG] Behavior simulation completed');

      // Final wait for exact duration
      const remainingTime = targetDuration - (Date.now() - stepStartTime);
      if (remainingTime > 0) {
        await this.engine.wait(remainingTime);
      }

      const actualDuration = Date.now() - stepStartTime;
      
      logger.info(`Funnel step completed`, {
        tier: step.tier,
        siteId: step.siteId,
        duration: Math.round(actualDuration / 1000),
        targetDuration: step.durationSeconds
      });

    } catch (error) {
      logger.error(`Funnel step failed`, {
        tier: step.tier,
        siteId: step.siteId,
        url: step.url,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private async performContextualClick(): Promise<void> {
    const clickResult = await this.engine.evaluate((blacklist) => {
      const HIGH_VALUE = ['about', 'product', 'service', 'feature', 'price', 'blog', 'case', 'contact'];
      const LOW_VALUE = ['login', 'register', 'signin', 'signup', 'terms', 'privacy', 'policy', 'legal'];

      const links = Array.from(document.querySelectorAll("a"))
        .filter(a => {
          const href = a.href;
          return href && !blacklist.some((b: string) => href.includes(b)) && href.startsWith(window.location.origin);
        })
        .map(a => {
          const text = (a.innerText || a.title || "").toLowerCase().trim();
          let score = 10; // Base score
          
          if (HIGH_VALUE.some(k => text.includes(k))) score += 20;
          if (LOW_VALUE.some(k => text.includes(k))) score -= 5;
          
          // Surface area bonus (prefer larger elements/buttons)
          const rect = a.getBoundingClientRect();
          score += Math.min(rect.width * rect.height / 1000, 10);

          return { href: a.href, score, text };
        });

      if (links.length === 0) return null;

      // Weighted random selection
      const totalScore = links.reduce((sum, l) => sum + l.score, 0);
      let rand = Math.random() * totalScore;
      
      for (const link of links) {
        rand -= link.score;
        if (rand <= 0) {
          window.location.href = link.href;
          return { href: link.href, text: link.text };
        }
      }
      return null;
    }, this.blacklist);

    if (clickResult) {
      logger.info(`Contextual click performed: "${clickResult.text}" -> ${clickResult.href}`);
    } else {
      logger.debug('No suitable links found for contextual click.');
    }
  }
}
