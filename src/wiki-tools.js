/**
 * Read-only model tools for the knowledge wiki.
 *
 * These tools are the only model-facing path into `wiki/`; the build pipeline is
 * host-only. No tool in this module writes a page, index or skill.
 */
import { wikiStoreFor, readWikiPage, searchWiki, validateWikiAnswer, wikiLinks } from './wiki-query.js';

const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
  },
  required: ['ok'],
  additionalProperties: true,
});

function warn(scope, error) {
  // eslint-disable-next-line no-console
  console.warn(`[cc-memory] ${scope}:`, error?.message ?? error);
}

function argsOf(args) {
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {};
}

async function projectFor(runtime, exec) {
  const agent = exec?.agent;
  if (!agent) return undefined;
  return runtime.forAgent(agent);
}

function result(ok, extra = {}) {
  return { ok, ...extra };
}

/**
 * Register `wiki_search`, `wiki_read`, `wiki_links`, `wiki_answer`.
 * @param {object} ctx plugin context
 * @param {object} runtime MemoryRuntime
 * @returns {() => void} disposer
 */
export function registerWikiTools(ctx, runtime) {
  let tools;
  try {
    tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools;
  } catch (error) {
    warn('tools service', error);
    tools = undefined;
  }
  if (!tools || typeof tools.register !== 'function') {
    warn('tools service', new Error('ctx.tools is unavailable; wiki tools are not registered'));
    return () => {};
  }
  const disposers = [];
  const register = (definition) => {
    try {
      const dispose = tools.register(definition);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      warn(`register ${definition.name}`, error);
    }
  };
  const config = () => runtime?.config ?? {};
  const enabled = () => config().wikiEnabled !== false && config().enabled !== false;

  const withStore = async (exec, handler) => {
    if (!enabled()) return result(false, { error: 'wiki-disabled', message: 'knowledge wiki is disabled' });
    try {
      const pctx = await projectFor(runtime, exec);
      if (!pctx?.paths?.wikiDir) return result(false, { error: 'no-project' });
      const store = wikiStoreFor(pctx, config());
      if (!store) return result(false, { error: 'no-wiki' });
      return await handler(store, pctx);
    } catch (error) {
      return result(false, { error: 'wiki-error', message: String(error?.message ?? error) });
    }
  };

  register({
    name: 'wiki_search',
    description: 'Search the read-only knowledge wiki and return page hits with citations. Use before answering corpus questions.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words or a question to search for.' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum hits (default 5).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const input = argsOf(args);
      return withStore(exec, async (store) => {
        const query = typeof input.query === 'string' ? input.query.trim() : '';
        if (query === '') return result(false, { error: 'invalid-query' });
        const hits = await searchWiki(store, query, { limit: Number(input.limit) || 5 });
        return result(true, { hits, count: hits.length });
      });
    },
  });

  register({
    name: 'wiki_read',
    description: 'Read one page of the read-only knowledge wiki in full, including its [[links]] and citations.',
    parameters: {
      type: 'object',
      properties: { page: { type: 'string', description: 'Page file name, for example deal_overview.md.' } },
      required: ['page'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const input = argsOf(args);
      return withStore(exec, async (store) => {
        const file = typeof input.page === 'string' ? input.page.trim() : '';
        if (file === '') return result(false, { error: 'invalid-page' });
        const page = await readWikiPage(store, file);
        if (!page) return result(false, { error: 'not-found', page: file });
        return result(true, {
          page: page.file,
          name: page.name,
          description: page.description,
          body: page.body,
          links: page.links,
          citations: page.citations,
          claims: page.claims,
        });
      });
    },
  });

  register({
    name: 'wiki_links',
    description: 'List a wiki page\'s outgoing [[links]] and backlinks, so you can traverse related topics.',
    parameters: {
      type: 'object',
      properties: { page: { type: 'string', description: 'Page file name.' } },
      required: ['page'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const input = argsOf(args);
      return withStore(exec, async (store) => {
        const file = typeof input.page === 'string' ? input.page.trim() : '';
        if (file === '') return result(false, { error: 'invalid-page' });
        const graph = await wikiLinks(store, file);
        return result(true, graph);
      });
    },
  });

  register({
    name: 'wiki_answer',
    description: 'Submit a wiki-grounded answer with citations; the host checks every cited page, claim id and quote, and reports a fact with no record instead of accepting a guess.',
    parameters: {
      type: 'object',
      properties: {
        answer: { type: 'string', description: 'The answer, using only facts from the wiki.' },
        citations: {
          type: 'array',
          description: 'One citation per factual statement: use the claimId returned by wiki_search/wiki_read.',
          items: {
            type: 'object',
            properties: {
              page: { type: 'string', description: 'Page file name.' },
              claimId: { type: 'string', description: 'Required stable fact-claim id for the supporting fact line; a page-level citation, or an id from another page, is rejected.' },
              quote: { type: 'string', description: 'Optional short quote from that page.' },
            },
            required: ['page', 'claimId'],
          },
        },
      },
      required: ['answer', 'citations'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const input = argsOf(args);
      return withStore(exec, async (store) => {
        const answer = typeof input.answer === 'string' ? input.answer : '';
        const citations = Array.isArray(input.citations) ? input.citations : [];
        const checked = await validateWikiAnswer(store, { answer, citations });
        return result(checked.ok, {
          accepted: checked.ok,
          errors: checked.errors,
          citations: checked.citations,
          noRecord: checked.noRecord === true,
        });
      });
    },
  });

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch (error) {
        warn('dispose wiki tool', error);
      }
    }
  };
}
