import { logger } from '../logging/logger';

export interface IPDetails {
  ip: string;
  status: string;
  country: string;
  city: string;
  isp: string;
  hosting: boolean;
  proxy: boolean;
  vpn: boolean;
}

interface CachedIPDetails {
  data: IPDetails;
  timestamp: number;
}

export class ReputationService {
  private static CACHE = new Map<string, CachedIPDetails>();
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private static readonly MAX_REQUESTS_PER_MINUTE = 40; // Leave margin under 45 limit
  private static requestTimestamps: number[] = [];
  private static lastRequestTime: number = 0;

  /**
   * Checks the reputation of an IP address using ip-api.com
   * Implements caching with TTL and rate limiting to respect free tier (45 req/min).
   */
  public static async checkIP(proxyServer?: string): Promise<IPDetails | null> {
    const cacheKey = proxyServer || 'direct';
    
    // Check cache first with TTL validation
    const cached = this.CACHE.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL_MS) {
      logger.debug('IP check served from cache', { ip: cached.data.ip, cacheKey });
      return cached.data;
    }

    // Rate limiting: ensure we don't exceed 40 req/min
    await this.enforceRateLimit();

    try {
      // Use ip-api.com to get advanced fields including hosting/proxy/vpn detection
      const response = await fetch('http://ip-api.com/json/?fields=status,message,country,city,isp,query,hosting,proxy,vpn');
      
      if (!response.ok) {
        throw new Error(`IP Check failed: ${response.statusText}`);
      }

      const data = await response.json() as any;

      if (data.status === 'fail') {
        logger.warn('IP Reputation check failed', { message: data.message });
        return null;
      }

      const details: IPDetails = {
        ip: data.query,
        status: data.status,
        country: data.country,
        city: data.city,
        isp: data.isp,
        hosting: data.hosting || false,
        proxy: data.proxy || false,
        vpn: data.vpn || false,
      };

      this.CACHE.set(cacheKey, { data: details, timestamp: Date.now() });
      
      const isBurnt = details.hosting || details.proxy || details.vpn;
      if (isBurnt) {
        logger.warn('Proxy Reputation Alert: IP looks suspicious/burnt', { 
           ip: details.ip, 
           hosting: details.hosting, 
           proxy: details.proxy, 
           vpn: details.vpn 
        });
      } else {
        logger.info('Proxy Reputation Clean', { ip: details.ip, isp: details.isp });
      }

      return details;
    } catch (error) {
      logger.error('Failed to perform IP reputation check', { error });
      return null;
    }
  }

  /**
   * Enforce rate limiting to respect IP-API free tier (45 req/min)
   * Waits if necessary to stay under limit.
   */
  private static async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    
    // Clean old timestamps
    this.requestTimestamps = this.requestTimestamps.filter(ts => ts > oneMinuteAgo);
    
    // If at limit, wait until oldest request expires
    if (this.requestTimestamps.length >= this.MAX_REQUESTS_PER_MINUTE) {
      const oldestRequest = this.requestTimestamps[0];
      const waitTime = oldestRequest + 60000 - now;
      
      if (waitTime > 0) {
        logger.warn('IP-API rate limit reached, waiting', { waitTimeMs: waitTime });
        await new Promise(resolve => setTimeout(resolve, waitTime + 100)); // +100ms buffer
      }
    }
    
    // Add current request timestamp
    this.requestTimestamps.push(Date.now());
  }

  /**
   * Force clear cache (useful for testing or manual refresh)
   */
  public static clearCache(): void {
    this.CACHE.clear();
    this.requestTimestamps = [];
    logger.info('IP reputation cache cleared');
  }

  /**
   * Get cache statistics
   */
  public static getCacheStats(): { size: number; oldestEntry: number | null } {
    const timestamps = Array.from(this.CACHE.values()).map(c => c.timestamp);
    return {
      size: this.CACHE.size,
      oldestEntry: timestamps.length > 0 ? Math.min(...timestamps) : null
    };
  }
}
