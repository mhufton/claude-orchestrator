import type { Ticket } from '../state/types';

export interface AreaDetection {
  areaType: 'label' | 'path' | 'component' | 'keyword';
  areaValue: string;
  confidence: number;
}

export interface TicketAreas {
  ticketId: number;
  areas: AreaDetection[];
  primaryArea: string;
}

// Labels that indicate codebase areas
const AREA_LABELS = new Set([
  'frontend', 'backend', 'server', 'web', 'api', 'database', 'db',
  'infra', 'infrastructure', 'cdk', 'ui', 'docs', 'documentation',
  'testing', 'tests', 'ci', 'devops', 'auth', 'security'
]);

// Path patterns to detect areas from file mentions in issue body
const PATH_PATTERNS: Array<{ pattern: RegExp; area: string }> = [
  { pattern: /\bserver\/(\w+)/gi, area: 'server' },
  { pattern: /\bweb\/src\/(\w+)/gi, area: 'web' },
  { pattern: /\bweb\/src\/components/gi, area: 'web:components' },
  { pattern: /\bweb\/src\/lib/gi, area: 'web:lib' },
  { pattern: /\binfra\//gi, area: 'infra' },
  { pattern: /\bbin\//gi, area: 'tooling' },
  { pattern: /\.tsx?\b/gi, area: 'typescript' },
  { pattern: /\.css\b/gi, area: 'styling' },
  { pattern: /\.sql\b/gi, area: 'database' },
];

// Component name patterns (PascalCase names ending with common suffixes)
const COMPONENT_PATTERN = /\b([A-Z][a-zA-Z0-9]*(?:Card|Page|Component|View|Modal|Dialog|Form|Button|List|Table|Panel|Container|Provider|Context|Hook|Service|Handler|Manager|Controller|Worker|Spawner|Watcher|Detector|Machine))\b/g;

// Keyword-to-area mapping
const KEYWORD_AREAS: Array<{ keywords: RegExp; area: string }> = [
  { keywords: /\b(button|modal|dialog|form|input|dropdown|tooltip|menu|navbar|sidebar|header|footer)\b/gi, area: 'ui' },
  { keywords: /\b(endpoint|route|api|rest|graphql|request|response|fetch)\b/gi, area: 'api' },
  { keywords: /\b(query|table|migration|schema|database|sqlite|postgres|mysql)\b/gi, area: 'database' },
  { keywords: /\b(test|spec|mock|fixture|jest|vitest|coverage)\b/gi, area: 'testing' },
  { keywords: /\b(deploy|ci|pipeline|workflow|action|docker|kubernetes|k8s)\b/gi, area: 'devops' },
  { keywords: /\b(auth|login|logout|session|token|jwt|oauth|permission|role)\b/gi, area: 'auth' },
  { keywords: /\b(websocket|socket|realtime|broadcast|subscribe|event)\b/gi, area: 'realtime' },
  { keywords: /\b(state|redux|zustand|context|store|reducer|action)\b/gi, area: 'state' },
];

/**
 * Detect areas from a ticket's labels, title, and body.
 */
export function detectAreas(ticket: Ticket): TicketAreas {
  const areas: AreaDetection[] = [];
  const text = `${ticket.title}\n${ticket.body || ''}`;

  // 1. Label-based detection (highest confidence)
  try {
    const labels: string[] = JSON.parse(ticket.labels || '[]');
    for (const label of labels) {
      const normalizedLabel = label.toLowerCase().trim();
      if (AREA_LABELS.has(normalizedLabel)) {
        areas.push({
          areaType: 'label',
          areaValue: normalizedLabel,
          confidence: 1.0
        });
      }
    }
  } catch {
    // Invalid labels JSON, skip
  }

  // 2. Path-based detection
  for (const { pattern, area } of PATH_PATTERNS) {
    pattern.lastIndex = 0; // Reset regex state
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      areas.push({
        areaType: 'path',
        areaValue: area,
        confidence: 0.9
      });
    }
  }

  // 3. Component-based detection
  COMPONENT_PATTERN.lastIndex = 0;
  const componentMatches = text.match(COMPONENT_PATTERN);
  if (componentMatches) {
    // Group by suffix to determine area
    const suffixAreas: Record<string, string> = {
      'Card': 'web:components',
      'Page': 'web:pages',
      'Component': 'web:components',
      'View': 'web:views',
      'Modal': 'web:components',
      'Dialog': 'web:components',
      'Form': 'web:components',
      'Button': 'web:components',
      'List': 'web:components',
      'Table': 'web:components',
      'Panel': 'web:components',
      'Container': 'web:components',
      'Provider': 'web:providers',
      'Context': 'web:context',
      'Hook': 'web:hooks',
      'Service': 'server:services',
      'Handler': 'server:handlers',
      'Manager': 'server:managers',
      'Controller': 'server:controllers',
      'Worker': 'server:workers',
      'Spawner': 'server:agents',
      'Watcher': 'server:watchers',
      'Detector': 'server:detectors',
      'Machine': 'server:state',
    };

    for (const match of componentMatches) {
      for (const [suffix, area] of Object.entries(suffixAreas)) {
        if (match.endsWith(suffix)) {
          areas.push({
            areaType: 'component',
            areaValue: area,
            confidence: 0.8
          });
          break;
        }
      }
    }
  }

  // 4. Keyword-based detection
  for (const { keywords, area } of KEYWORD_AREAS) {
    keywords.lastIndex = 0;
    const matches = text.match(keywords);
    if (matches && matches.length >= 2) { // Require at least 2 keyword matches
      areas.push({
        areaType: 'keyword',
        areaValue: area,
        confidence: 0.6
      });
    }
  }

  // Deduplicate areas by value, keeping highest confidence
  const areaMap = new Map<string, AreaDetection>();
  for (const area of areas) {
    const existing = areaMap.get(area.areaValue);
    if (!existing || existing.confidence < area.confidence) {
      areaMap.set(area.areaValue, area);
    }
  }

  const dedupedAreas = Array.from(areaMap.values());
  const primaryArea = computePrimaryArea(dedupedAreas);

  return {
    ticketId: ticket.id,
    areas: dedupedAreas,
    primaryArea
  };
}

/**
 * Compute the primary area from a list of detected areas.
 * Prioritizes by confidence, then by specificity.
 */
function computePrimaryArea(areas: AreaDetection[]): string {
  if (areas.length === 0) return 'general';

  // Sort by confidence (descending), then prefer more specific areas
  const sorted = [...areas].sort((a, b) => {
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }
    // Prefer more specific areas (those with colons are more specific)
    const aSpecific = a.areaValue.includes(':') ? 1 : 0;
    const bSpecific = b.areaValue.includes(':') ? 1 : 0;
    return bSpecific - aSpecific;
  });

  return sorted[0].areaValue;
}

/**
 * Check if two tickets can be batched together based on their areas.
 */
export function canBatchTogether(ticket1Areas: TicketAreas, ticket2Areas: TicketAreas): boolean {
  // Must have the same primary area
  if (ticket1Areas.primaryArea !== ticket2Areas.primaryArea) {
    return false;
  }

  // Don't batch "general" tickets (no clear area)
  if (ticket1Areas.primaryArea === 'general') {
    return false;
  }

  return true;
}

/**
 * Group tickets by their primary area for batching.
 * Returns a map of area -> tickets that can be batched together.
 * Only returns groups with 2+ tickets.
 */
export function findBatchableTickets(
  tickets: Ticket[],
  minBatchSize: number = 2,
  maxBatchSize: number = 5
): Map<string, Ticket[]> {
  const areaGroups = new Map<string, Ticket[]>();

  for (const ticket of tickets) {
    const areas = detectAreas(ticket);
    const key = areas.primaryArea;

    // Skip "general" tickets - they have no clear area
    if (key === 'general') continue;

    if (!areaGroups.has(key)) {
      areaGroups.set(key, []);
    }
    areaGroups.get(key)!.push(ticket);
  }

  // Filter to groups that meet minimum size and cap at max size
  const result = new Map<string, Ticket[]>();
  for (const [area, groupTickets] of areaGroups) {
    if (groupTickets.length >= minBatchSize) {
      // Take up to maxBatchSize tickets
      result.set(area, groupTickets.slice(0, maxBatchSize));
    }
  }

  return result;
}

/**
 * Generate a human-readable batch name from an area key and tickets.
 */
export function generateBatchName(areaKey: string, tickets: Ticket[]): string {
  const ticketNumbers = tickets.map(t => `#${t.github_issue_number}`).join(', ');
  const areaDisplay = areaKey.replace(':', ' / ').replace(/^\w/, c => c.toUpperCase());
  return `${areaDisplay} (${ticketNumbers})`;
}
