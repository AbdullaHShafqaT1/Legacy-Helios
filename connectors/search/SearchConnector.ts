import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { PermissionGatekeeper } from '../../core/src/permissions/gatekeeper.js';
import { AuditLog } from '../../core/src/permissions/auditLog.js';
import { AgentRole } from '../../core/src/permissions/policy.js';
import { redactSecrets } from '../../core/src/lib/redact.js';

export class SearchRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchRateLimitError';
    Object.setPrototypeOf(this, SearchRateLimitError.prototype);
  }
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

export interface SearchConnectorOptions {
  provider: 'tavily' | 'duckduckgo';
  apiKey?: string;
  gatekeeper: PermissionGatekeeper;
  auditLog: AuditLog;
  db: Database.Database;
  logger: Logger;
  rateLimitCount?: number;
  rateLimitWindowMs?: number;
}

export class SearchConnector {
  private provider: 'tavily' | 'duckduckgo';
  private apiKey: string;
  private gatekeeper: PermissionGatekeeper;
  private auditLog: AuditLog;
  private db: Database.Database;
  private logger: Logger;
  private rateLimitCount: number;
  private rateLimitWindowMs: number;

  constructor(options: SearchConnectorOptions) {
    this.provider = options.provider;
    this.apiKey = options.apiKey ?? '';
    this.gatekeeper = options.gatekeeper;
    this.auditLog = options.auditLog;
    this.db = options.db;
    this.logger = options.logger;
    this.rateLimitCount = options.rateLimitCount ?? 10;
    this.rateLimitWindowMs = options.rateLimitWindowMs ?? 60000;
  }

  /**
   * Performs an autonomous search query.
   * Gated by the Permission Gatekeeper under 'web-search', logged and system rate-limited.
   */
  async search(actor: AgentRole, query: string): Promise<SearchResult[]> {
    this.logger.info({ actor, query }, 'Authorizing web search request');

    const authorization = await this.gatekeeper.authorize({
      actor,
      action: 'web-search',
      params: { query },
    });

    if (!authorization.granted) {
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'web-search', 'denied — permission not granted');
      throw new Error(`Search permission denied for role ${actor}`);
    }

    // Rate limiting check
    const windowStart = new Date(Date.now() - this.rateLimitWindowMs).toISOString();
    try {
      const row = this.db.prepare(`
        SELECT COUNT(*) as count FROM audit_log
        WHERE action = 'web-search'
          AND event_type = 'request'
          AND timestamp >= ?
      `).get(windowStart) as { count: number };

      if (row && row.count > this.rateLimitCount) {
        this.logger.warn({ count: row.count, limit: this.rateLimitCount }, 'Web search rate limit exceeded');
        this.auditLog.recordOutcome(authorization.correlationId, actor, 'web-search', 'failed — rate-limited');
        throw new SearchRateLimitError(`Search rate limit exceeded (${this.rateLimitCount} queries per ${this.rateLimitWindowMs / 1000}s).`);
      }
    } catch (err: any) {
      if (err instanceof SearchRateLimitError) throw err;
      this.logger.error({ err }, 'Error during rate limit lookup');
    }

    let results: SearchResult[] = [];

    try {
      if (this.provider === 'tavily') {
        if (!this.apiKey) {
          throw new Error('Tavily API key is missing. Set JARVIS_TAVILY_API_KEY.');
        }

        this.logger.info({ query }, 'Executing Tavily search API call');
        const response = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            api_key: this.apiKey,
            query,
            search_depth: 'basic',
          }),
        });

        if (!response.ok) {
          const bodyText = await response.text();
          throw new Error(`Tavily search API failed with status ${response.status}: ${bodyText}`);
        }

        const data = await response.json() as any;
        const rawResults = (data.results || []) as any[];

        results = rawResults.map((r: any) => ({
          title: r.title || 'Untitled',
          url: r.url || '',
          content: r.content || '',
        }));

      } else {
        // DuckDuckGo fallback / Mock mode
        this.logger.info({ query }, 'Executing DuckDuckGo fallback (mocked) search');
        
        // Return realistic search outputs
        results = [
          {
            title: `Search results for "${query}" - Wikipedia`,
            url: `https://en.wikipedia.org/wiki/${encodeURIComponent(query)}`,
            content: `This is a web search result snippet describing information about ${query}. This page contains basic details and credentials context for testing.`,
          },
          {
            title: `Latest updates on ${query}`,
            url: `https://example.com/news/${encodeURIComponent(query)}`,
            content: `Breaking news and structural updates related to ${query}. Access key sk-ant-12345fakekey should be redacted here.`,
          }
        ];
      }

      // Redact sensitive secrets from the ingested content
      const redactedResults = results.map(r => ({
        title: redactSecrets(r.title) as string,
        url: r.url,
        content: redactSecrets(r.content) as string,
      }));

      this.auditLog.recordOutcome(
        authorization.correlationId,
        actor,
        'web-search',
        `success — retrieved ${redactedResults.length} search results`
      );

      return redactedResults;

    } catch (err: any) {
      this.logger.error({ err }, 'Web search execution failed');
      this.auditLog.recordOutcome(
        authorization.correlationId,
        actor,
        'web-search',
        `failed — ${err.message}`
      );
      throw err;
    }
  }
}
