import { TrafficOrchestrator } from './application/traffic/TrafficOrchestrator';
import { PuppeteerStealthEngine } from './infrastructure/browser/PuppeteerStealthEngine';
import { Session } from './domain/entities/Session';
import { Config } from './infrastructure/config/config';
import { logger } from './infrastructure/logging/logger';
import { MetricsService } from './infrastructure/monitoring/MetricsService';
import { QueueService, TrafficJobData } from './infrastructure/queue/QueueService';
import { Job } from 'bullmq';
import { PBNTrafficManager } from './application/pbn/PBNTrafficManager';

async function setupMonitoring() {
  const metrics = MetricsService.getInstance();
  setInterval(() => {
    metrics.printSummary();
  }, 10000);
  return metrics;
}

async function runProducer() {
  logger.info('Role: PRODUCER - Adding initial tasks to queue', { 
    count: Config.MAX_SESSIONS,
    url: Config.DEFAULT_URL 
  });

  for (let i = 0; i < Config.MAX_SESSIONS; i++) {
    const durationMin = Config.SESSION_TIME === 'random' 
      ? Math.floor(Math.random() * (5 - 1 + 1) + 1) 
      : parseInt(Config.SESSION_TIME);

    const jobData: TrafficJobData = {
      url: Config.DEFAULT_URL,
      durationMinutes: durationMin,
      intensity: Config.BEHAVIOR_INTENSITY,
      proxy: Config.PROXY_URL ? {
        host: Config.PROXY_URL,
        port: Config.PROXY_PORT!,
        username: Config.PROXY_USER,
        password: Config.PROXY_PASS
      } : undefined
    };

    await QueueService.addSession(jobData);
  }
}

async function runWorker() {
  logger.info('Role: WORKER - Listening for tasks...', {
    concurrency: Config.MAX_SESSIONS
  });

  QueueService.createWorker(async (job: Job<TrafficJobData>) => {
    logger.info('Worker: Starting job', { jobId: job.id, url: job.data.url });
    const engine = new PuppeteerStealthEngine();
    const orchestrator = new TrafficOrchestrator(engine);
    
    try {
      await orchestrator.runFromJob(job.id!, job.data);
    } catch (err) {
      logger.error('Worker: Job target failed', { jobId: job.id, error: err });
      throw err; // Allow BullMQ to handle retry
    }
  });
}

async function bootstrap() {
  logger.info('Initializing Veneno Traffic Bot v2 (Distributed)', { 
    env: Config.NODE_ENV,
    role: Config.BOT_ROLE,
    redis: Config.REDIS_URL,
    pbnEnabled: Config.PBN_ENABLED
  });

  // Initialize Queue
  QueueService.initialize(Config.REDIS_URL);
  
  // Start Monitoring (only locally relevant if worker/both)
  if (Config.BOT_ROLE !== 'producer') {
    await setupMonitoring();
  }

  // PBN Mode: Execute PBN funnels if enabled
  if (Config.PBN_ENABLED) {
    logger.info('PBN Mode: Initializing Private Blog Network traffic generation');
    const pbnManager = new PBNTrafficManager();
    
    // Display PBN stats
    const stats = pbnManager.getStats();
    logger.info('PBN Network loaded', {
      sites: stats.sites,
      templates: stats.templates,
      keywords: stats.keywords,
      distribution: stats.sitesByTier
    });

    // Execute PBN campaign with configured keywords in infinite loop
    // Use MAX_SESSIONS to control total funnels per batch (not per keyword)
    const totalSessions = Config.MAX_SESSIONS;
    const pbnKeywords = pbnManager.getAvailableKeywords();
    
    if (pbnKeywords.length > 0) {
      let batchCount = 0;
      
      while (true) {
        batchCount++;
        logger.info('Starting PBN batch', { 
          batchNumber: batchCount,
          keywords: pbnKeywords.length,
          totalSessionsRequested: totalSessions 
        });
        
        // Calculate sessions per keyword to reach totalSessions max
        const sessionsPerKeyword = Math.max(1, Math.floor(totalSessions / pbnKeywords.length));
        
        await pbnManager.executeBatch(pbnKeywords, sessionsPerKeyword, {
          distributed: QueueService.isDistributedEnabled()
        });
        
        // Random delay between batches (10-30 seconds) for natural traffic flow
        const delaySeconds = Math.floor(Math.random() * 21) + 10; // 10-30s
        logger.info('Batch complete, waiting before next batch', { 
          batchNumber: batchCount,
          delaySeconds 
        });
        
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
      }
    }
    
    return; // PBN mode takes over
  }

  // Execute Roles
  if (Config.BOT_ROLE === 'producer' || Config.BOT_ROLE === 'both') {
    if (QueueService.isDistributedEnabled()) {
      await runProducer();
    } else if (Config.BOT_ROLE === 'both') {
      logger.info('Role: BOTH - Redis unavailable, falling back to local sequential execution');
      const engine = new PuppeteerStealthEngine();
      const orchestrator = new TrafficOrchestrator(engine);

      const { FingerprintService } = require('./infrastructure/browser/FingerprintService');
      
      for (let i = 0; i < Config.MAX_SESSIONS; i++) {
        const fingerprint = FingerprintService.generate();
        await orchestrator.run(new Session({
          id: `local-${i}`,
          url: Config.DEFAULT_URL,
          userAgent: fingerprint.userAgent,
          viewport: fingerprint.viewport,
          durationMs: (Config.SESSION_TIME === 'random' ? 3 : parseInt(Config.SESSION_TIME)) * 60000,
          proxy: Config.PROXY_URL ? {
            server: `${Config.PROXY_URL}:${Config.PROXY_PORT}`,
            username: Config.PROXY_USER,
            password: Config.PROXY_PASS
          } : undefined,
          userDataDir: Config.PERSISTENT_SESSIONS ? `${Config.SESSIONS_DATA_DIR}/session-${i}` : undefined
        }), {
          headless: Config.HEADLESS,
          platform: fingerprint.platform,
          fingerprintScript: FingerprintService.getInjectionScript(fingerprint)
        });
      }
    } else {
      logger.error('Role: PRODUCER - Redis unavailable, cannot add tasks.');
    }
  }

  if (Config.BOT_ROLE === 'worker' || Config.BOT_ROLE === 'both') {
    if (QueueService.isDistributedEnabled()) {
      await runWorker();
    } else if (Config.BOT_ROLE === 'worker') {
      logger.error('Role: WORKER - Redis unavailable, cannot listen for tasks.');
    }
  }

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, closing services...');
    await QueueService.close();
    process.exit(0);
  });
}

bootstrap().catch(err => {
  logger.error('Fatal crash during bootstrap', { err });
  process.exit(1);
});