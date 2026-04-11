import { TrafficOrchestrator } from '../traffic/TrafficOrchestrator';
import { PuppeteerStealthEngine } from '../../infrastructure/browser/PuppeteerStealthEngine';
import { FunnelPlannerService, funnelPlanner } from '../../infrastructure/pbn/FunnelPlannerService';
import { FunnelSession, CustomFunnelConfig } from '../../domain/entities/PBNSite';
import { Session } from '../../domain/entities/Session';
import { Config } from '../../infrastructure/config/config';
import { logger } from '../../infrastructure/logging/logger';
import { MetricsService } from '../../infrastructure/monitoring/MetricsService';
import { ReputationService } from '../../infrastructure/monitoring/ReputationService';
import { QueueService, TrafficJobData } from '../../infrastructure/queue/QueueService';
import { FingerprintService } from '../../infrastructure/browser/FingerprintService';

/**
 * PBN Traffic Manager - Orchestrates complete PBN traffic campaigns
 * 
 * Architecture: Tier3 (Social) → Tier2 (Expired) → Tier1 (EMD) → MoneySite
 * 
 * Features:
 * - Proxy rotation between funnels (fresh IP per funnel)
 * - IP validation before/after execution (ReputationService)
 * - Cookie persistence within funnel (same userDataDir for all tiers)
 * - Explicit cleanup after funnel (prevents cross-funnel correlation)
 * - Support for custom funnels with specific URLs per tier
 * 
 * Security: Each funnel gets isolated session data, no cookie sharing between funnels
 */
export class PBNTrafficManager {
  private funnelPlanner: FunnelPlannerService;
  private metrics: MetricsService;
  private proxyList: { host: string; port: number; username?: string; password?: string }[];
  private currentProxyIndex: number = 0;

  constructor(proxies?: { host: string; port: number; username?: string; password?: string }[]) {
    this.funnelPlanner = funnelPlanner;
    this.metrics = MetricsService.getInstance();
    
    // Load proxies from parameter or env config
    this.proxyList = proxies || this.loadProxiesFromEnv();
    
    logger.info('PBNTrafficManager initialized', { 
      proxiesAvailable: this.proxyList.length 
    });
  }

  /**
   * Load proxy list from environment or file
   * Supports:
   * 1. IPCOOK_PROXY_LIST: comma-separated list of host:port:user:pass
   * 2. IPCOOK_PROXY_FILE: path to file with one proxy per line
   * 3. Single proxy from Config.PROXY_URL/PORT/USER/PASS
   */
  private loadProxiesFromEnv(): { host: string; port: number; username?: string; password?: string; country?: string }[] {
    const proxies: { host: string; port: number; username?: string; password?: string; country?: string }[] = [];
    
    // IPCook proxy list (supports 1000+ proxies)
    const ipcookList = process.env.IPCOOK_PROXY_LIST;
    if (ipcookList) {
      const proxyStrings = ipcookList.split(',').map(p => p.trim()).filter(Boolean);
      
      for (const str of proxyStrings) {
        const parsed = this.parseIPCookProxy(str);
        if (parsed) proxies.push(parsed);
      }
      
      if (proxies.length > 0) {
        logger.info('Loaded IPCook proxies', { count: proxies.length });
        return proxies;
      }
    }
    
    // Try loading from proxy file (one proxy per line)
    // Support both absolute and relative paths from multiple base directories
    const path = require('path');
    const projectRoot = path.resolve(__dirname, '..', '..', '..');
    const proxyFiles = [
      process.env.IPCOOK_PROXY_FILE,
      '/app/proxy_listUS.txt',
      '/app/proxy_listFR.txt',
      path.join(projectRoot, 'src', 'infrastructure', 'proxy', 'proxy_listUS.txt'),
      path.join(projectRoot, 'src', 'infrastructure', 'proxy', 'proxy_listFR.txt'),
      path.join(projectRoot, 'proxies', 'ipcook_us.txt'),
      path.join(projectRoot, 'proxies', 'ipcook_fr.txt'),
      './src/infrastructure/proxy/proxy_listUS.txt',
      './src/infrastructure/proxy/proxy_listFR.txt',
      './proxies/ipcook_us.txt',
      './proxies/ipcook_fr.txt'
    ].filter(Boolean);
    
    logger.info('[DEBUG] Looking for proxy files', { projectRoot, filesToCheck: proxyFiles.length });
    
    let loadedFiles = 0;
    for (const filePath of proxyFiles) {
      if (!filePath) continue;
      try {
        const fs = require('fs');
        logger.debug('[DEBUG] Checking proxy file', { file: filePath, exists: fs.existsSync(filePath) });
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf-8');
          const lines = content.split('\n').map((l: string) => l.trim()).filter((l: string) => l && !l.startsWith('#'));
          
          logger.info('[DEBUG] Found proxy file', { file: filePath, lines: lines.length, firstLine: lines[0]?.substring(0, 40) });
          
          let fileProxies = 0;
          for (const line of lines) {
            const parsed = this.parseIPCookProxy(line);
            if (parsed) {
              proxies.push(parsed);
              fileProxies++;
            }
          }
          
          if (fileProxies > 0) {
            loadedFiles++;
            logger.info('Loaded proxies from file', { count: fileProxies, file: filePath });
          }
        }
      } catch (err) {
        logger.debug('[DEBUG] Failed to load proxy file', { file: filePath, error: (err as Error).message });
      }
    }
    
    if (proxies.length > 0) {
      logger.info('Total proxies loaded from all files', { total: proxies.length, files: loadedFiles });
      return proxies;
    }
    
    // Single proxy from config (fallback)
    if (Config.PROXY_URL && Config.PROXY_PORT) {
      proxies.push({
        host: Config.PROXY_URL,
        port: Config.PROXY_PORT,
        username: Config.PROXY_USER,
        password: Config.PROXY_PASS
      });
    }
    
    return proxies;
  }

  /**
   * Parse IPCook proxy format: host:port:username:password
   * Example: geo.ipcook.com:32345:ernesto010802-US:Lannion22300
   * Country extracted from username if contains -XX suffix
   */
  private parseIPCookProxy(str: string): { host: string; port: number; username: string; password: string; country?: string } | null {
    const parts = str.split(':');
    if (parts.length < 4) {
      logger.warn('Invalid IPCook proxy format', { str, expected: 'host:port:user:pass' });
      return null;
    }

    const [host, portStr, username, ...passParts] = parts;
    const port = parseInt(portStr, 10);
    const password = passParts.join(':'); // Password may contain colons
    
    if (isNaN(port)) {
      logger.warn('Invalid proxy port', { str, portStr });
      return null;
    }

    // Extract country from username (format: username-CC)
    const countryMatch = username.match(/-([A-Z]{2})$/);
    const country = countryMatch ? countryMatch[1] : undefined;

    return { host, port, username, password, country };
  }

  /**
   * Get next proxy for rotation between funnels
   * Each funnel gets a fresh proxy
   */
  private getNextProxy(): { host: string; port: number; username?: string; password?: string } | undefined {
    if (this.proxyList.length === 0) {
      return undefined;
    }
    
    if (this.proxyList.length === 1) {
      return this.proxyList[0];
    }
    
    const proxy = this.proxyList[this.currentProxyIndex];
    this.currentProxyIndex = (this.currentProxyIndex + 1) % this.proxyList.length;
    
    logger.debug('Rotated to next proxy', { 
      index: this.currentProxyIndex, 
      total: this.proxyList.length,
      host: proxy.host 
    });
    
    return proxy;
  }

  /**
   * Execute a single PBN funnel for a keyword
   */
  async executeFunnel(keyword: string, templateId?: string): Promise<boolean> {
    logger.info('Starting PBN funnel execution', { keyword, template: templateId });

    try {
      // Plan the funnel
      const funnelSession = await this.funnelPlanner.planFunnel(keyword, templateId);
      
      if (!funnelSession) {
        logger.error('Failed to plan funnel', { keyword });
        return false;
      }

      // Execute with fresh engine
      const engine = new PuppeteerStealthEngine();
      const orchestrator = new TrafficOrchestrator(engine);

      await orchestrator.runFunnel(funnelSession, {
        headless: Config.HEADLESS
      });

      return true;

    } catch (error) {
      logger.error('PBN funnel execution failed', { 
        keyword, 
        error: error instanceof Error ? error.message : String(error) 
      });
      return false;
    }
  }

  /**
   * Execute a custom funnel with specific URLs for each tier
   */
  async executeCustomFunnel(config: CustomFunnelConfig): Promise<boolean> {
    logger.info('Starting custom PBN funnel execution', { 
      id: config.id, 
      name: config.name,
      keyword: config.targetKeyword
    });

    try {
      // Plan custom funnel
      const funnelSession = this.funnelPlanner.planCustomFunnel(config);
      
      if (!funnelSession) {
        logger.error('Failed to plan custom funnel', { id: config.id });
        return false;
      }

      // Execute with specific proxy if provided
      const engine = new PuppeteerStealthEngine();
      const orchestrator = new TrafficOrchestrator(engine);

      await orchestrator.runFunnel(funnelSession, {
        headless: Config.HEADLESS
      });

      logger.info('Custom funnel completed', { 
        id: config.id,
        steps: funnelSession.steps.length
      });

      return true;

    } catch (error) {
      logger.error('Custom funnel execution failed', { 
        id: config.id,
        error: error instanceof Error ? error.message : String(error) 
      });
      return false;
    }
  }

  /**
   * Execute multiple custom funnels with specific URLs
   */
  async executeCustomFunnels(
    configs: CustomFunnelConfig[],
    options: { distributed?: boolean } = {}
  ): Promise<{
    total: number;
    successful: number;
    failed: number;
  }> {
    logger.info('Starting custom funnels batch execution', { 
      funnels: configs.length
    });

    const results = { total: configs.length, successful: 0, failed: 0 };

    for (const config of configs) {
      // Handle repeat count
      const repeatCount = config.repeatCount || 1;
      
      for (let i = 0; i < repeatCount; i++) {
        try {
          const success = await this.executeCustomFunnel(config);
          if (success) {
            results.successful++;
          } else {
            results.failed++;
          }
          
          // Delay between runs if specified
          if (config.delayBetweenRuns && i < repeatCount - 1) {
            await new Promise(resolve => setTimeout(resolve, config.delayBetweenRuns! * 1000));
          } else {
            await this.delayBetweenFunnels();
          }
        } catch (error) {
          results.failed++;
          logger.error('Custom funnel failed', { 
            id: config.id,
            run: i + 1,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    logger.info('Custom funnels batch complete', {
      total: results.total,
      successful: results.successful,
      failed: results.failed
    });

    return results;
  }

  /**
   * Execute batch of PBN funnels for multiple keywords
   */
  async executeBatch(
    keywords: string[], 
    sessionsPerKeyword: number = 1,
    options: { distributed?: boolean } = {}
  ): Promise<{
    total: number;
    successful: number;
    failed: number;
    funnels: FunnelSession[];
  }> {
    logger.info('Starting PBN batch execution', { 
      keywords: keywords.length,
      sessionsPerKeyword 
    });

    const results = {
      total: 0,
      successful: 0,
      failed: 0,
      funnels: [] as FunnelSession[]
    };

    // Plan all funnels first
    const funnelSessions = await this.funnelPlanner.planBatchFunnels(keywords, sessionsPerKeyword);
    results.total = funnelSessions.length;
    results.funnels = funnelSessions;

    if (options.distributed && QueueService.isDistributedEnabled()) {
      // Distributed mode: add to queue
      for (const session of funnelSessions) {
        await this.addToQueue(session);
      }
      logger.info(`Added ${funnelSessions.length} funnels to distributed queue`);
    } else {
      // Local mode: execute with limited concurrency (5 funnels in parallel max)
      const concurrencyLimit = 5;
      const executing: Promise<void>[] = [];
      
      for (let i = 0; i < funnelSessions.length; i++) {
        const session = funnelSessions[i];
        
        // Create promise for this funnel
        const funnelPromise = (async () => {
          try {
            // Get fresh proxy for this funnel (rotation between funnels)
            const proxy = this.getNextProxy();
            
            const success = await this.executeFunnelSession(session, proxy);
            if (success) {
              results.successful++;
            } else {
              results.failed++;
            }
          } catch (error) {
            results.failed++;
            logger.error('Funnel failed in batch', { 
              sessionId: session.id,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        })();
        
        executing.push(funnelPromise);
        
        // When we hit the concurrency limit, wait for one to complete before adding more
        if (executing.length >= concurrencyLimit) {
          await Promise.race(executing);
          // Remove completed promises
          const index = executing.findIndex(p => p === funnelPromise);
          if (index > -1) executing.splice(index, 1);
        }
      }
      
      // Wait for all remaining funnels to complete
      await Promise.all(executing);
    }

    logger.info('PBN batch execution complete', {
      total: results.total,
      successful: results.successful,
      failed: results.failed,
      successRate: `${((results.successful / results.total) * 100).toFixed(1)}%`
    });

    return results;
  }

  /**
   * Execute a single funnel session (internal)
   * With IP validation, cookie persistence, and proxy rotation
   */
  private async executeFunnelSession(session: FunnelSession, proxy?: { host: string; port: number; username?: string; password?: string }): Promise<boolean> {
    const startTime = Date.now();
    const sessionId = session.id;
    
    // 1. Validate IP before starting (if proxy provided)
    let initialIp: string | null = null;
    if (proxy) {
      const ipCheck = await ReputationService.checkIP(`${proxy.host}:${proxy.port}`);
      if (ipCheck) {
        initialIp = ipCheck.ip;
        logger.info('Starting funnel with validated IP', { 
          sessionId, 
          ip: initialIp,
          country: ipCheck.country,
          isp: ipCheck.isp
        });
        
        // Alert if IP is burnt
        if (ipCheck.hosting || ipCheck.proxy || ipCheck.vpn) {
          logger.warn('Warning: Using potentially flagged IP', { 
            sessionId, 
            hosting: ipCheck.hosting,
            proxy: ipCheck.proxy,
            vpn: ipCheck.vpn
          });
        }
      }
    }

    // 2. Create session with cookie persistence
    const fingerprint = FingerprintService.generate();
    const userDataDir = Config.PERSISTENT_SESSIONS 
      ? `${Config.SESSIONS_DATA_DIR}/pbn-${sessionId}` 
      : undefined;

    const trafficSession = new Session({
      id: sessionId,
      url: session.steps[0]?.url || Config.DEFAULT_URL,
      durationMs: session.steps.reduce((sum, s) => sum + s.durationSeconds * 1000, 0),
      userAgent: fingerprint.userAgent,
      viewport: fingerprint.viewport,
      proxy: proxy ? {
        server: `${proxy.host}:${proxy.port}`,
        username: proxy.username,
        password: proxy.password
      } : undefined,
      userDataDir
    });

    const engine = new PuppeteerStealthEngine();
    const orchestrator = new TrafficOrchestrator(engine);

    try {
      logger.info('Executing PBN funnel with persistence', { 
        sessionId, 
        steps: session.steps.length,
        userDataDir: userDataDir || 'none',
        proxy: proxy ? `${proxy.host}:${proxy.port}` : 'none'
      });

      await orchestrator.runFunnel(session, {
        headless: Config.HEADLESS,
        userDataDir,
        proxy: trafficSession.config.proxy
      });

      // 3. Validate IP after completion (check stability)
      if (proxy && initialIp) {
        const finalCheck = await ReputationService.checkIP(`${proxy.host}:${proxy.port}`);
        if (finalCheck && finalCheck.ip !== initialIp) {
          logger.warn('IP changed during funnel execution', { 
            sessionId, 
            initialIp, 
            finalIp: finalCheck.ip 
          });
        } else {
          logger.info('IP remained stable throughout funnel', { sessionId, ip: initialIp });
        }
      }

      const duration = Date.now() - startTime;
      logger.info('Funnel completed successfully', { 
        sessionId, 
        durationMs: duration,
        stepsCompleted: session.steps.length
      });

      return true;

    } catch (error) {
      logger.error('Funnel session execution failed', {
        sessionId,
        keyword: session.targetKeyword,
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    } finally {
      // Always cleanup user data dir to prevent correlation between funnels
      await this.cleanupUserDataDir(userDataDir);
    }
  }

  /**
   * Clean up user data directory after funnel completion
   * Removes cookies, localStorage, and fingerprint data
   */
  private async cleanupUserDataDir(userDataDir: string | undefined): Promise<void> {
    if (!userDataDir || !Config.PERSISTENT_SESSIONS) {
      return; // Nothing to cleanup
    }

    try {
      const fs = require('fs');
      const path = require('path');
      
      // Check if directory exists
      if (fs.existsSync(userDataDir)) {
        // Remove directory recursively
        fs.rmSync(userDataDir, { recursive: true, force: true });
        logger.debug('Cleaned up user data directory', { userDataDir });
      }
    } catch (error) {
      // Log but don't fail - cleanup is best effort
      logger.warn('Failed to cleanup user data directory', { 
        userDataDir, 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  }

  /**
   * Add funnel to distributed queue
   */
  private async addToQueue(session: FunnelSession): Promise<void> {
    const totalDuration = session.steps.reduce((sum, s) => sum + s.durationSeconds, 0);
    
    const jobData: TrafficJobData = {
      url: session.steps[0]?.url || Config.DEFAULT_URL,
      durationMinutes: Math.ceil(totalDuration / 60),
      intensity: 'medium',
      proxy: Config.PROXY_URL ? {
        host: Config.PROXY_URL,
        port: Config.PROXY_PORT!,
        username: Config.PROXY_USER,
        password: Config.PROXY_PASS
      } : undefined
    };

    await QueueService.addSession(jobData);
    
    logger.debug('Added funnel to queue', {
      sessionId: session.id,
      keyword: session.targetKeyword,
      steps: session.steps.length
    });
  }

  /**
   * Generate human-like delay using log-normal distribution
   * More realistic than uniform random (humans have variable but clustered timing)
   */
  private humanLikeDelay(
    minMs: number = 5000,
    maxMs: number = 15000,
    meanMs: number = 8000
  ): number {
    // Box-Muller transform for normal distribution
    const u1 = Math.random();
    const u2 = Math.random();
    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    
    // Scale to desired mean with some variance
    const stdDev = (meanMs - minMs) / 2;
    let delay = meanMs + z0 * stdDev;
    
    // Clamp to bounds and add jitter
    delay = Math.max(minMs, Math.min(maxMs, delay));
    delay += (Math.random() - 0.5) * 1000; // ±500ms jitter
    
    return Math.floor(delay);
  }

  /**
   * Delay between funnel executions using human-like timing
   */
  private async delayBetweenFunnels(): Promise<void> {
    const delay = this.humanLikeDelay(5000, 15000, 8000); // 5-15s, centered on 8s
    logger.debug('Human-like delay between funnels', { delayMs: delay });
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  /**
   * Get PBN statistics
   */
  getStats(): {
    sites: number;
    sitesByTier: Record<string, number>;
    templates: number;
    keywords: number;
  } {
    return this.funnelPlanner.getStats();
  }

  /**
   * List available keywords from configuration
   */
  getAvailableKeywords(): string[] {
    return this.funnelPlanner['keywordMappings'].map(k => k.keyword);
  }

  /**
   * List available templates
   */
  getAvailableTemplates(): { id: string; name: string; description: string; probability: number }[] {
    return this.funnelPlanner['templates'].map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      probability: t.probability
    }));
  }
}
