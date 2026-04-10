import fs from 'fs';
import path from 'path';
import { logger } from '../logging/logger';

interface UserAgentEntry {
  ua: string;
  platform?: string;
  browser?: string;
}

export class UserAgentService {
  private static UA_DIR = path.join(process.cwd(), 'useragent');
  private static cache: Record<string, UserAgentEntry[]> = {};

  // Default fallback UAs if files are missing
  private static readonly DEFAULT_UAS: UserAgentEntry[] = [
    { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', platform: 'win32', browser: 'chrome' },
    { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', platform: 'darwin', browser: 'chrome' },
    { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', platform: 'linux', browser: 'chrome' },
    { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0', platform: 'win32', browser: 'firefox' },
    { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15', platform: 'darwin', browser: 'safari' }
  ];

  /**
   * Gets a random User-Agent, optionally filtered by type and platform.
   * Also performs non-destructive randomization of minor version components.
   */
  static getRandomUA(type: string = 'most-common', platform?: string): { ua: string; platform: string } {
    const entries = this.loadEntries(type);
    
    // Filter by platform if provided (mapping win32/darwin/linux)
    let filtered = platform 
      ? entries.filter(e => e.platform === platform)
      : entries;

    // Fallback if no entries match the platform
    if (filtered.length === 0) {
      filtered = entries;
    }

    const selected = filtered[Math.floor(Math.random() * filtered.length)];
    const randomizedUA = this.randomizeVersion(selected.ua);

    return { 
      ua: randomizedUA, 
      platform: selected.platform || 'win32' 
    };
  }

  private static loadEntries(type: string): UserAgentEntry[] {
    if (this.cache[type]) return this.cache[type];

    const filePath = path.join(this.UA_DIR, `${type}.json`);
    if (!fs.existsSync(filePath)) {
      logger.warn(`User-Agent file not found: ${filePath}, using default UAs`);
      this.cache[type] = this.DEFAULT_UAS;
      return this.cache[type];
    }

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      this.cache[type] = Array.isArray(data) ? data : [];
      return this.cache[type];
    } catch (error) {
      logger.error(`Failed to parse User-Agent file: ${filePath}, using default UAs`, { error });
      this.cache[type] = this.DEFAULT_UAS;
      return this.cache[type];
    }
  }

  /**
   * Randomizes the minor/patch version parts of Chrome User-Agents
   * Example: Chrome/145.0.0.0 -> Chrome/145.0.4285.12
   */
  private static randomizeVersion(ua: string): string {
    const build = Math.floor(Math.random() * 5000) + 1000;
    const patch = Math.floor(Math.random() * 200);

    // Randomize Chrome version
    let randomized = ua.replace(/Chrome\/(\d+)\.0\.0\.0/, (_, major) => {
      return `Chrome/${major}.0.${build}.${patch}`;
    });

    // Also randomize Edg version if present
    randomized = randomized.replace(/Edg\/(\d+)\.0\.0\.0/, (_, major) => {
      return `Edg/${major}.0.${build}.${patch}`;
    });

    return randomized;
  }
}
