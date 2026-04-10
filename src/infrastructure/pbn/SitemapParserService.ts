import { logger } from '../logging/logger';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

interface SitemapCache {
  urls: string[];
  timestamp: number;
}

/**
 * SitemapParserService - Parse WordPress sitemaps and return random article URLs
 * Prevents hitting the same blog post every time
 */
export class SitemapParserService {
  private cache: Map<string, SitemapCache> = new Map();
  private readonly CACHE_TTL = 30 * 60 * 1000; // 30 minutes

  /**
   * Fetch and parse sitemap XML, return random URL
   */
  async getRandomUrl(sitemapUrl: string): Promise<string | null> {
    try {
      // Check cache first
      const cached = this.cache.get(sitemapUrl);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        return this.getRandomFromArray(cached.urls);
      }

      // Fetch fresh sitemap
      const urls = await this.fetchSitemap(sitemapUrl);
      
      if (urls.length === 0) {
        logger.warn('No URLs found in sitemap', { sitemapUrl });
        return null;
      }

      // Filter for blog posts (exclude homepage, categories, tags)
      const blogPosts = urls.filter(url => this.isBlogPost(url));
      
      // Cache results
      this.cache.set(sitemapUrl, {
        urls: blogPosts.length > 0 ? blogPosts : urls,
        timestamp: Date.now()
      });

      const targetUrls = blogPosts.length > 0 ? blogPosts : urls;
      const randomUrl = this.getRandomFromArray(targetUrls);
      
      logger.debug('Sitemap parsed', { 
        sitemapUrl, 
        totalUrls: urls.length, 
        blogPosts: blogPosts.length,
        selected: randomUrl 
      });

      return randomUrl;
    } catch (error) {
      logger.error('Failed to parse sitemap', { sitemapUrl, error });
      return null;
    }
  }

  /**
   * Fetch sitemap XML content
   */
  private async fetchSitemap(url: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'https:' ? https : http;
      
      const request = client.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 10000,
        rejectUnauthorized: false
      }, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          try {
            const urls = this.parseXml(data);
            resolve(urls);
          } catch (error) {
            reject(error);
          }
        });
      });

      request.on('error', reject);
      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }

  /**
   * Parse XML sitemap and extract URLs
   */
  private parseXml(xml: string): string[] {
    const urls: string[] = [];
    
    // Match <loc>https://example.com/post</loc> patterns
    const locRegex = /<loc>([^<]+)<\/loc>/g;
    let match;
    
    while ((match = locRegex.exec(xml)) !== null) {
      const url = match[1].trim();
      if (this.isValidUrl(url)) {
        urls.push(url);
      }
    }

    return urls;
  }

  /**
   * Check if URL is a blog post (not homepage, category, tag, etc.)
   */
  private isBlogPost(url: string): boolean {
    const excludePatterns = [
      /\/$/,  // homepage
      /\/page\/\d+\//,  // pagination
      /\/category\//,
      /\/tag\//,
      /\/author\//,
      /\/sitemap/,
      /feed$/,
      /rss$/,
      /\.xml$/,
      /search/,
      /\?/,  // query strings
      /#/  // anchors
    ];

    return !excludePatterns.some(pattern => pattern.test(url));
  }

  /**
   * Validate URL format
   */
  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return url.startsWith('http://') || url.startsWith('https://');
    } catch {
      return false;
    }
  }

  /**
   * Get random element from array
   */
  private getRandomFromArray<T>(array: T[]): T {
    return array[Math.floor(Math.random() * array.length)];
  }

  /**
   * Clear cache for specific sitemap or all
   */
  clearCache(sitemapUrl?: string): void {
    if (sitemapUrl) {
      this.cache.delete(sitemapUrl);
    } else {
      this.cache.clear();
    }
  }

  /**
   * Get cache stats
   */
  getCacheStats(): { size: number; urls: number } {
    let totalUrls = 0;
    this.cache.forEach(entry => totalUrls += entry.urls.length);
    return { size: this.cache.size, urls: totalUrls };
  }
}

export const sitemapParser = new SitemapParserService();
