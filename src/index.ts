#!/usr/bin/env node
import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import axios, { AxiosResponse } from 'axios';

// Helper function for console logging
const logDebug = (message: string) => {
  const timestamp = `[${new Date().toISOString()}]`;
  console.error(`${timestamp} ${message}`);
};

interface SentryIssue {
  id: string;
  title: string;
  permalink: string;
}

interface SentryRelease {
  version: string;
  [key: string]: any;
}

// Configuration from environment variables
const SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN;
const SENTRY_BASE_URL = process.env.SENTRY_BASE_URL;
const SENTRY_ORG_SLUG = process.env.SENTRY_ORG_SLUG;

if (!SENTRY_AUTH_TOKEN) {
  console.error('Error: SENTRY_AUTH_TOKEN environment variable is required.');
  process.exit(1);
}
if (!SENTRY_BASE_URL) {
  console.error('Error: SENTRY_BASE_URL environment variable is required.');
  process.exit(1);
}
if (!SENTRY_ORG_SLUG) {
  console.error('Error: SENTRY_ORG_SLUG environment variable is required.');
  process.exit(1);
}

declare module 'axios' {
  interface AxiosRequestConfig {
    retry?: number;
    retryDelay?: (retryCount: number) => number;
    __retryCount?: number;
  }

  interface AxiosDefaults extends AxiosRequestConfig {
    retry?: number;
    retryDelay?: (retryCount: number) => number;
  }
}

const axiosInstance = axios.create({
  baseURL: SENTRY_BASE_URL,
  headers: {
    Authorization: `Bearer ${SENTRY_AUTH_TOKEN}`,
    'Content-Type': 'application/json'
  },
  timeout: 10000, // 10 second timeout
  retry: 3, // Retry 3 times on failures
  retryDelay: (retryCount: number) => retryCount * 1000 // 1s, 2s, 3s delays
});

// Add retry interceptor
axiosInstance.interceptors.response.use(undefined, (err) => {
  const config = err.config;
  if (!config || !config.retry) return Promise.reject(err);
  
  config.__retryCount = config.__retryCount || 0;
  if (config.__retryCount >= config.retry) {
    return Promise.reject(err);
  }
  
  config.__retryCount += 1;
  const delay = typeof config.retryDelay === 'function' 
    ? config.retryDelay(config.__retryCount)
    : config.retryDelay;
  
  return new Promise((resolve) => {
    setTimeout(() => resolve(axiosInstance(config)), delay);
  });
});

// Simple tools implementation
interface GetIssueParams {
  issue_id: string;
  org_slug: string;
  project_slug: string;
}

interface GetReleaseIssuesParams {
  project_slug: string;
}

async function getLatestReleaseVersion(orgSlug: string, projectSlug: string): Promise<string> {
  const releasesUrl = `${SENTRY_BASE_URL}projects/${orgSlug}/${projectSlug}/releases/`;
  logDebug(`Fetching latest release from: ${releasesUrl}`);
  const response = await axiosInstance.get(releasesUrl);
  if (!response.data?.[0]?.version) {
    throw new Error('No releases found');
  }
  return response.data[0].version;
}

interface SentryReleaseResponse {
  version: string;
  dateCreated: string;
  newGroups: number;
  [key: string]: any;
}

async function getSortedReleases(orgSlug: string, projectSlug: string): Promise<Array<{
  version: string;
  dateCreated: string;
  newGroups: number;
}>> {
  const url = `projects/${orgSlug}/${projectSlug}/releases/`;
  const response = await axiosInstance.get<SentryReleaseResponse[]>(url);
  return response.data
    .sort((a: SentryReleaseResponse, b: SentryReleaseResponse) => 
      new Date(b.dateCreated).getTime() - new Date(a.dateCreated).getTime())
    .map((release: SentryReleaseResponse) => ({
      version: release.version,
      dateCreated: release.dateCreated,
      newGroups: release.newGroups
    }));
}

const tools = {
  inspect_sentry: {
    exec: async () => {
      return {
        configuration: {
          baseUrl: SENTRY_BASE_URL,
          authTokenConfigured: !!SENTRY_AUTH_TOKEN,
          defaultOrg: SENTRY_ORG_SLUG // Use env var
        },
        capabilities: Object.keys(tools).filter(k => k !== 'inspect_sentry'),
        environment: {
          nodeVersion: process.version,
          platform: process.platform,
          memoryUsage: process.memoryUsage()
        }
      };
    }
  },
  list_recent_releases: {
    exec: async (params: {project_slug: string; org_slug?: string; count?: number}) => {
      const orgSlug = params.org_slug || SENTRY_ORG_SLUG; // Use env var as default
      const count = params.count || 5;
      const releases = await getSortedReleases(orgSlug, params.project_slug);
      return releases.slice(0, count).map(release => ({
        version: release.version,
        date: release.dateCreated,
        new_issues: release.newGroups,
        type: release.version.includes('mobile') ? 'mobile' : 'desktop'
      }));
    }
  },
  get_releases: {
    exec: async (params: {project_slug: string; org_slug?: string}) => {
      const orgSlug = params.org_slug || SENTRY_ORG_SLUG; // Use env var as default
      return getSortedReleases(orgSlug, params.project_slug);
    }
  },
  get_release_health: {
    exec: async (params: {project_slug: string; org_slug?: string; release_version?: string}) => {
      const orgSlug = params.org_slug || SENTRY_ORG_SLUG; // Use env var as default
      const releaseVersion = params.release_version || await getLatestReleaseVersion(orgSlug, params.project_slug);
      
      const healthUrl = `${SENTRY_BASE_URL}projects/${orgSlug}/${params.project_slug}/releases/${encodeURIComponent(releaseVersion)}/`;
      logDebug(`Fetching release health from: ${healthUrl}`);
      const response = await axiosInstance.get(healthUrl);
      
      return {
        version: releaseVersion,
        new_issues: response.data.new_groups,
        crash_free_rate: response.data.crash_free_rate,
        sessions: response.data.sessions,
        stats: response.data.stats
      };
    }
  },
  get_issue: {
    exec: async (params: GetIssueParams) => {
      const response = await axiosInstance.get(`/issues/${params.issue_id}/`);
      return {
        id: response.data.id,
        title: response.data.title,
        permalink: response.data.permalink
      };
    }
  },
  get_release_issues: {
    // Updated to fetch issues directly using query parameters
    exec: async (params: GetReleaseIssuesParams & {org_slug?: string; release_version?: string}) => {
      const orgSlug = params.org_slug || SENTRY_ORG_SLUG; // Use env var as default
      let releaseVersion = params.release_version;

      // If release_version is not provided, fetch the latest one
      if (!releaseVersion) {
        const releasesUrl = `${SENTRY_BASE_URL}projects/${orgSlug}/${params.project_slug}/releases/`; // Construct full URL
        logDebug(`Fetching latest release from: ${releasesUrl}`); 
        const releasesResponse = await axiosInstance.get(releasesUrl); // Pass full URL
        logDebug(`Got releases response status: ${releasesResponse.status}`); 
        if (!releasesResponse.data || !Array.isArray(releasesResponse.data) || releasesResponse.data.length === 0) { 
          throw new Error(`No releases found for project ${params.project_slug}`);
        }
        releaseVersion = releasesResponse.data[0].version;
        logDebug(`Using latest release version: ${releaseVersion}`); 
      } else {
        logDebug(`Using provided release version: ${releaseVersion}`); 
      }

      if (!releaseVersion) {
        throw new Error('Could not determine release version.');
      }

      // First get project ID (89 in this case)
      const projectUrl = `${SENTRY_BASE_URL}projects/${orgSlug}/${params.project_slug}/`;
      logDebug(`Fetching project details from: ${projectUrl}`);
      const project = await axiosInstance.get(projectUrl);
      
      // Then get issues filtered by release
      const issuesUrl = `${SENTRY_BASE_URL}organizations/${orgSlug}/issues/`;
      const issuesParams = {
        project: project.data.id, // Use numeric project ID
        query: `release:"${releaseVersion}"`
      };
      logDebug(`Fetching issues from: ${issuesUrl} with params: ${JSON.stringify(issuesParams)}`);
      const issues = await axiosInstance.get(issuesUrl, { params: issuesParams });
      return issues.data.map((issue: any) => ({
        id: issue.id,
        title: issue.title,
        permalink: issue.permalink
      }));
    }
  }
};

// Define capabilities separately
const serverCapabilities = {
  tools: {
    inspect_sentry: {
        description: 'Inspect server configuration and capabilities',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      list_recent_releases: {
        description: 'List most recent releases with issue counts',
        inputSchema: {
          type: 'object',
          properties: {
            project_slug: { type: 'string' },
            org_slug: { type: 'string' },
            count: { type: 'number' }
          },
          required: ['project_slug']
        }
      },
      get_releases: {
        description: 'Get all releases sorted by date (newest first)',
        inputSchema: {
          type: 'object',
          properties: {
            project_slug: { type: 'string' },
            org_slug: { type: 'string' }
          },
          required: ['project_slug']
        }
      },
      get_release_health: {
        description: 'Get health metrics for a release',
        inputSchema: {
          type: 'object',
          properties: {
            project_slug: { type: 'string' },
            org_slug: { type: 'string' },
            release_version: { type: 'string' }
          },
          required: ['project_slug']
        }
      },
      get_issue: {
        description: 'Get a Sentry issue by ID',
        inputSchema: {
          type: 'object',
          properties: {
            issue_id: { type: 'string' },
            org_slug: { type: 'string' },
            project_slug: { type: 'string' }
          },
          required: ['issue_id', 'org_slug', 'project_slug']
        }
      },
      get_release_issues: {
        description: 'Get issues from a specific release (defaults to latest)',
        inputSchema: {
          type: 'object',
          properties: {
            project_slug: { type: 'string', description: "Project slug (e.g., 'renaissance')" },
            org_slug: { type: 'string', description: `Organization slug (defaults to SENTRY_ORG_SLUG: ${SENTRY_ORG_SLUG})` },
            release_version: { type: 'string', description: "Optional: Specific release version (defaults to latest)" }
          },
          required: ['project_slug'] // org_slug defaults to SENTRY_ORG_SLUG
        }
    }
  }
};

// MCP server setup
const server = new Server({
  name: 'sentry-mcp',
  version: '0.1.0'
}, { capabilities: serverCapabilities }); // Pass the capabilities object here

import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Handler to list available tools for the inspector
server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Use the serverCapabilities constant defined above
  const toolDefinitions = serverCapabilities.tools || {};
  return {
    tools: Object.entries(toolDefinitions).map(([name, definition]) => ({
      name,
      // TypeScript should now correctly infer the type of 'definition'
      description: definition.description,
      inputSchema: definition.inputSchema,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (!request.params.name || !tools[request.params.name as keyof typeof tools]) {
    throw new Error('Tool not found');
  }
  
  const tool = tools[request.params.name as keyof typeof tools];
  let result: any;
  
  try {
    if (request.params.name === 'list_recent_releases') {
      const args = request.params.arguments;
      if (!args || typeof args !== 'object' || !('project_slug' in args)) {
        throw new Error('Invalid arguments for list_recent_releases - requires project_slug');
      }
      result = await tools.list_recent_releases.exec({
        project_slug: String(args.project_slug),
        org_slug: args.org_slug ? String(args.org_slug) : undefined,
        count: args.count ? Number(args.count) : undefined
      });
    } else if (request.params.name === 'get_releases') {
      const args = request.params.arguments;
      if (!args || typeof args !== 'object' || !('project_slug' in args)) {
        throw new Error('Invalid arguments for get_releases - requires project_slug');
      }
      result = await tools.get_releases.exec({
        project_slug: String(args.project_slug),
        org_slug: args.org_slug ? String(args.org_slug) : undefined
      });
    } else if (request.params.name === 'get_issue') {
      const args = request.params.arguments;
      if (!args || typeof args !== 'object' || !('issue_id' in args) || !('org_slug' in args) || !('project_slug' in args)) {
        throw new Error('Invalid arguments for get_issue - requires issue_id, org_slug and project_slug');
      }
      result = await tools.get_issue.exec({
        issue_id: String(args.issue_id),
        org_slug: String(args.org_slug),
        project_slug: String(args.project_slug)
      });
    } else if (request.params.name === 'get_release_issues') {
      const args = request.params.arguments;
      if (!args || typeof args !== 'object' || !('project_slug' in args)) {
        throw new Error('Invalid arguments for get_release_issues - requires project_slug');
      }
      result = await tools.get_release_issues.exec({
        project_slug: String(args.project_slug),
        // Pass org_slug if provided, otherwise use SENTRY_ORG_SLUG from env
        org_slug: args.org_slug ? String(args.org_slug) : SENTRY_ORG_SLUG
      });
    } else if (request.params.name === 'inspect_sentry') { // Added handler for inspect_sentry
      result = await tools.inspect_sentry.exec();
    } else if (request.params.name === 'get_release_health') { // Added handler for get_release_health
       const args = request.params.arguments;
       if (!args || typeof args !== 'object' || !('project_slug' in args)) {
         throw new Error('Invalid arguments for get_release_health - requires project_slug');
       }
       result = await tools.get_release_health.exec({
         project_slug: String(args.project_slug),
         org_slug: args.org_slug ? String(args.org_slug) : SENTRY_ORG_SLUG,
         release_version: args.release_version ? String(args.release_version) : undefined
       });
    } else {
      throw new Error('Unknown tool');
    }
    return {
      _meta: {},
      content: [{
        type: 'text',
        text: JSON.stringify(result)
      }]
    };
  } catch (error) {
    return {
      _meta: {},
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Failed to execute tool',
          details: error instanceof Error ? error.message : String(error)
        })
      }],
      isError: true
    };
  }
});

// Type-safe global error tracking
declare global {
  var lastError: Error | null;
}

// Debug endpoint implementation
import { z } from 'zod';

const DebugRequestSchema = z.object({
  method: z.literal('debug'),
  params: z.object({}).optional()
});

server.setRequestHandler(DebugRequestSchema, async () => {
  return {
    _meta: {},
    content: [{
      type: 'text',
      text: JSON.stringify({
        environment: {
          SENTRY_BASE_URL: process.env.SENTRY_BASE_URL,
          SENTRY_AUTH_TOKEN: '***' + (process.env.SENTRY_AUTH_TOKEN ? process.env.SENTRY_AUTH_TOKEN.slice(-4) : 'missing'),
          NODE_ENV: process.env.NODE_ENV
        },
        axiosConfig: axiosInstance.defaults,
        versions: process.versions
      }, null, 2)
    }]
  };
});

// Simple and reliable server startup
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Server started successfully');

// Log registered tools
console.error('Registered tools:', Object.keys(tools));

// Log server start with configuration
console.error('Sentry MCP server running with configuration:', {
  baseURL: SENTRY_BASE_URL,
  authTokenPresent: !!SENTRY_AUTH_TOKEN,
  nodeVersion: process.version
});

// Initialize global error tracker
global.lastError = null;
process.on('unhandledRejection', (err) => {
  global.lastError = err as Error;
  console.error('Unhandled rejection:', err);
});
