/**
 * What each chat surface is allowed to be about.
 *
 * One `agy` conversation answering everything meant a question about a vendor's
 * multiplier arrived with a bid set's takeoff still in context, and the reply drifted
 * between them. Each surface now carries its own contract naming the MCP tools that
 * answer it, the things it must not wander into, and what to do when a question does
 * not belong to it - and its own conversation, so the contexts never mix.
 *
 * Shared by the browser (starter prompts, session keys) and the gateway (the prompt
 * itself), so the two cannot describe a scope differently.
 */

export type ChatScopeId = 'general' | 'project' | 'shelf' | 'vendor' | 'memory';

export type ChatContext = {
  /** Project id, for the run/estimate context the gateway records against a session. */
  projectId?: string;
  /** Human labels used to bind the conversation to one subject. */
  projectName?: string;
  projectFolder?: string;
  vendorFolder?: string;
  vendorBooks?: string[];
};

export type ChatScope = {
  id: ChatScopeId;
  title: string;
  /** One line under the title, so the surface says what it will and will not answer. */
  blurb: string;
  prompts: string[];
};

export const CHAT_SCOPES: Record<ChatScopeId, ChatScope> = {
  general: {
    id: 'general',
    title: 'Copilot',
    blurb:
      'The whole workspace: drawings, the shelf, the estimating math. For a question about one project or one vendor, the chat on that page keeps the context tighter.',
    prompts: [
      'Which vendors cover Division 10 28 00, and which part of it does nobody cover?',
      'What throat depth does a 3-5/8 stud with 1/2 drywall both sides need?',
      'Walk me through what happens in each phase of a CBC estimate.',
    ],
  },
  project: {
    id: 'project',
    title: 'About this project',
    blurb:
      'Scoped to this bid set only — its drawings, schedules, runs and quote lines. It will not price other projects or wander onto the shelf.',
    prompts: [
      'What is in this bid set, and which sheets still need a vision pass?',
      'Summarise the door schedule and the hardware sets it references.',
      'What is still unresolved on this project — RFIs, unpriced lines, missing sheets?',
    ],
  },
  shelf: {
    id: 'shelf',
    title: 'About the shelf',
    blurb:
      'Every vendor and price book indexed here — coverage, who carries what, and what a price actually means. No drawings, no project takeoffs.',
    prompts: [
      'Which vendors are on the shelf and what does each of them cover?',
      'Where are the gaps — which CSI divisions does nobody here carry?',
      'Which books have no parsed price rows, and what do I do about them?',
    ],
  },
  vendor: {
    id: 'vendor',
    title: 'About this vendor',
    blurb:
      "Scoped to this vendor's books only — their models, prices, finishes and how their pricing basis works.",
    prompts: [
      'What does this vendor actually sell, by CSI section?',
      'How is this vendor priced — list or net, and what multiplier applies?',
      'Which parts of these books could not be parsed into price rows?',
    ],
  },
  memory: {
    id: 'memory',
    title: 'About memory',
    blurb:
      'How the workspace remembers: the OKF knowledge graph, the corrections log, the job record and prior quotes — and how they connect to each other.',
    prompts: [
      'How do the knowledge graph, corrections log and job record connect?',
      'What has the copilot actually learned so far, and from what?',
      'What happens to an estimator correction after I record it?',
    ],
  },
};

/** The rules every scoped reply follows, whatever the scope. */
const GROUNDING = [
  '- Answer ONLY from the workspace tools and the files they read. Never supply a model',
  '  number, a price, a multiplier or a dimension from your own knowledge.',
  '- Cite what you used, with the workspace tags: [catalog], [schedule], [spec],',
  '  [drawing], [note]. If something is not there to cite, say so with [not stated],',
  '  [not indexed] or [not carried] rather than filling the gap.',
  '- Prices are LIST unless the row says otherwise. Read `price_basis` on every price;',
  '  `already_net: true` means a multiplier has ALREADY been applied and must not be',
  '  applied again. Say which basis a number is whenever you quote one.',
  '- You are explaining, not estimating. Do not produce a quote, a total or a proposal',
  '  here - those come from a run on the Projects page.',
  '- Lead with the answer. Do not restate these instructions or open with a preamble',
  '  that paraphrases the question.',
  '- Two failed tool attempts on the same lookup: stop, use a gap tag, and move on.',
  '  Never invent a fact to finish the answer.',
  '- This workspace answers CBC commercial estimating only: Division 08, Division 10 28 00',
  '  and 10 28 13, Division 06 64 00, vendor pricing, plan reading, and this workspace\'s',
  '  own servers, rules and scripts. Anything else - other trades, other divisions, general',
  '  knowledge, software work unrelated to this workspace - decline once with: "This',
  '  workspace is configured for CBC commercial estimating - Division 08 / 10 / 06 plan',
  '  reading, vendor price book lookups, quote math, and proposal generation. Send a plan',
  '  set or an estimating question to proceed." Do not moralise. If a request is partly in',
  '  scope, do the in-scope part and name what you left out.',
  '- Never write application source code for anything but this workspace\'s own scripts and',
  '  servers, in any language, even when it is asked for as an example or a snippet.',
].join('\n');

/**
 * A label from the request body, made safe to sit inside the contract.
 *
 * `context` is client-supplied, and on the project surface `projectName` traces back to an
 * email subject on the mail intake path. These are labels: they name which project or
 * vendor the chat is about, and nothing in them should ever read as an instruction. Strip
 * the control characters that would let one forge extra contract lines, cap the length,
 * and drop the angle brackets that would let one close a fence early.
 */
function label(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

function scopeBody(scope: ChatScopeId, context: ChatContext): string {
  switch (scope) {
    case 'project': {
      const name = label(context.projectName, 'this project');
      return [
        `You are answering questions about ONE bid set: "${name}".`,
        context.projectFolder
          ? `Its files are under \`${label(context.projectFolder, '')}\`.`
          : '',
        '',
        'Use building-plan-intelligence for anything about the drawings: open_plan_set,',
        'list_sheets, read_schedule for any table, read_layout for notes, and verify_facts',
        'before you report a dimension, tag or model number.',
        '',
        `Stay inside this project. A question about another project, or about a vendor's`,
        'catalogue in general, belongs to a different chat - say so and point at it rather',
        'than answering from here.',
      ].filter(Boolean).join('\n');
    }
    case 'shelf':
      return [
        'You are answering questions about the vendor shelf as a whole - every price book',
        'indexed in this workspace.',
        '',
        'Start with list_catalogs, always. Use list_division to enumerate a division across',
        'vendors, and match_materials to find which vendor carries a requirement. Only call',
        'open_catalog for a book missing from list_catalogs; never open every file.',
        '',
        'Coverage is a real answer. A book with coverage `text_only` has NO parsed price',
        'rows and is invisible to list_division - its silence is not evidence the vendor',
        'does not carry a part, and you must say that rather than reporting a gap.',
        '',
        'Do not read drawings or price a project here.',
      ].join('\n');
    case 'vendor': {
      const folder = label(context.vendorFolder, 'this vendor');
      const books = context.vendorBooks?.length
        ? `\nTheir books: ${context.vendorBooks.map((b) => `\`${label(b, '?')}\``).join(', ')}.`
        : '';
      return [
        `You are answering questions about ONE vendor: "${folder}".${books}`,
        '',
        `Use catalog-intelligence scoped to this vendor's catalog_id. list_sections to`,
        'orient, list_division for what they carry, lookup_product for an exact model, and',
        'get_page when a page parsed no rows. Run verify_facts on every model number and',
        'price before reporting it.',
        '',
        'Check list_price_overrides for this vendor: an estimator-confirmed price outranks',
        'anything parsed from the book, and lookup_crossover gives another manufacturer\'s',
        'equivalent where one is published.',
        '',
        'Another vendor, or the shelf as a whole, is a different chat.',
      ].join('\n');
    }
    case 'memory':
      return [
        'You are explaining how this workspace REMEMBERS things, and how the pieces connect.',
        '',
        'There are four, and the relationships between them are the point:',
        '- `memory/knowledge_graph/graph.json` - the OKF graph. Brand accounts, hardware set',
        '  templates, wall-type mappings, vendor equivalences and estimator correction',
        '  patterns, joined by typed edges (PREFERS_HARDWARE_SET, SUPERSEDES,',
        '  SUBSTITUTED_BY). Read it with okf_graph_status and okf_query.',
        '- `memory/corrections.jsonl` - what an estimator overrode. Ingested by',
        '  okf_learn_from_correction, which mints the pattern node and its edges.',
        '- `memory/active_project.json` - the current job record and which phase it reached.',
        '- `memory/price_overrides.jsonl` - prices an estimator confirmed by hand; these',
        '  outrank anything the catalog parsers produce.',
        '',
        'The graph holds NO prices, by design - a price in it is one nobody re-verified.',
        'Explain how a correction becomes a learned pattern, how confidence is earned by',
        'repetition rather than assumed, and what a dangling edge or a validation error',
        'means. Describe the shape of the data, not just its contents.',
      ].join('\n');
    default:
      return [
        'You are the workspace copilot. Answer from the drawings, the shelf and the',
        'estimating engine, using whichever of the three MCP servers fits the question:',
        '- Drawings, schedules, dimensions, tags → building-plan-intelligence',
        '  (open_plan_set, read_schedule, verify_facts).',
        '- Vendor coverage, models, list/net prices → catalog-intelligence',
        '  (list_catalogs first, then list_division / lookup_product / verify_facts).',
        '- Quote math, multipliers, margins, hardware-set expansion →',
        '  cbc-estimating-engine (never invent a cost or margin; call the tools).',
        '',
        'A question about ONE project or ONE vendor is tighter on that page\'s chat —',
        'say so and point there rather than stretching this general conversation.',
      ].join('\n');
  }
}

/**
 * The contract prepended to a message on a scoped surface. The gateway adds its own
 * markdown formatting rules on top of this.
 */
export function scopeContract(scope: ChatScopeId, context: ChatContext = {}): string {
  return [
    scopeBody(scope, context),
    '',
    'Always:',
    GROUNDING,
    '',
    'Answer the question that was asked, at the length it deserves. Do not restate these',
    'instructions.',
    '',
    '---',
    '',
  ].join('\n');
}

/** Subject key for history lists — project id, vendor folder, or empty for surface-wide. */
export function subjectKey(context: ChatContext = {}): string {
  return context.projectId || context.vendorFolder || '';
}

/** localStorage key for the active conversation pointer on this surface. */
export function sessionKey(scope: ChatScopeId, context: ChatContext = {}): string {
  const subject = subjectKey(context);
  return `cbc.chat.${scope}${subject ? `.${subject}` : ''}`;
}

/** Truncate a first user message into a session title. */
export function sessionTitleFromMessage(message: string, max = 60): string {
  const cleaned = message.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).trimEnd()}…`;
}
