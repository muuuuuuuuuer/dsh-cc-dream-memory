import { MemoryStatusChipReady } from './status-chip.js';
import { MemoryViewReady } from './view.js';
import { NS, makeFallbackTranslate, registerDictionaries } from './i18n.js';
import { RECALL_DEFINITION, RECALL_KIND, RecallRowReady, parseRecall } from './recall-row.js';
import { apiRequest, createBackend, discoverBridge, sessionIdOf } from './api.js';
import { attentionCount, countByTrust, countByType, errorInfo, filterEntries, loadSummary, matchesTrust, opKind, projectLabel, readinessText, reasonText, splitBody, trustOf, viaLabel } from './model.js';
import { errorKey, normalizeDreamHistory, normalizeFile, normalizeFileHistory, normalizeHealth, normalizeMetrics, normalizePendingSwitch, normalizeReadiness, normalizeSearch, normalizeStatus, normalizeTrend } from './normalize.js';
import { formatError } from './format.js';
import { renderInline, renderMarkdown } from './markdown.js';
import { setBackendFactory } from './slot-props.js';

import { initializeReact } from './react.js';

const inject = ['slots', 'locale'];

async function apply(ctx) {
  const fallbackT = makeFallbackTranslate(ctx);

  try {
    registerDictionaries(ctx);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[cc-memory] dictionary setup failed:', formatError(error));
  }

  let boundT = fallbackT;
  try {
    if (ctx.locale && typeof ctx.locale.bind === 'function') boundT = ctx.locale.bind(NS);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[cc-memory] locale bind failed:', formatError(error));
  }

  // The silent HTTP API is the only data path; page data never touches the
  // session log.
  let api = await discoverBridge();
  let discovery;
  const connection = {
    get current() { return api; },
    get() {
      if (api) return api;
      discovery ??= discoverBridge().then((next) => {
        api = next;
        return next;
      }).finally(() => { discovery = undefined; });
      return discovery;
    },
    invalidate(previous) {
      if (api === previous) api = null;
    },
  };
  const backendFor = (sessionId) => createBackend({ connection, sessionId });
  setBackendFactory(backendFor);
  const labelT = boundT;

  // 1. Memory page
  try {
    ctx.slots.inject('conversation.view', () =>
      ctx.slots.register(
        {
          name: 'conversation.view',
          id: 'cc-memory',
          order: 40,
          label: () => {
            try {
              return labelT('view.title');
            } catch {
              return 'Memory';
            }
          },
          inject: (owner) => {
            const sessionId = sessionIdOf(owner);
            return {
              memSessionId: sessionId,
              memBackend: backendFor(sessionId),
              memT: fallbackT,
            };
          },
        },
        MemoryViewReady,
      ),
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[cc-memory] memory view registration failed:', formatError(error));
  }

  // 2. Composer status chip
  try {
    ctx.slots.inject('conversation.composer.dock', () =>
      ctx.slots.register(
        {
          name: 'conversation.composer.dock',
          id: 'cc-memory-status',
          order: 50,
          inject: (owner) => ({ memBackend: backendFor(sessionIdOf(owner)), memT: fallbackT }),
        },
        MemoryStatusChipReady,
      ),
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[cc-memory] status chip registration failed:', formatError(error));
  }

  // 3. Recall row in the chat flow. The Chat target is optional: without
  // the conversation service the attachment keeps its generic injected-context row.
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['uiConversation'], (conversation) => {
        conversation.effect(
          () => conversation.uiConversation.events.register(RECALL_DEFINITION),
          'cc-memory: recall event',
        );
        conversation.slots.inject('conversation.chat.node', () =>
          conversation.slots.register(
            {
              name: 'conversation.chat.node',
              key: RECALL_KIND,
              inject: (owner) => ({ memBackend: backendFor(sessionIdOf(owner)), memT: fallbackT }),
            },
            RecallRowReady,
          ),
        );
      });
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[cc-memory] recall row registration failed:', formatError(error));
  }
}

window.__ModuleLoader__.load({
  id: NS,
  factory(require) {
    initializeReact(require('react'));

    try {
      if (typeof window !== 'undefined') {
        window.__CC_MEMORY_INTERNALS__ = {
          normalizeStatus,
          errorKey,
          normalizeFile,
          createBackend,
          renderMarkdown,
          renderInline,
          apiRequest,
          normalizeMetrics,
          normalizeReadiness,
          normalizeHealth,
          normalizeDreamHistory,
          normalizeSearch,
          normalizeTrend,
          normalizePendingSwitch,
          normalizeFileHistory,
          filterEntries,
          countByType,
          countByTrust,
          trustOf,
          matchesTrust,
          splitBody,
          loadSummary,
          errorInfo,
          reasonText,
          opKind,
          projectLabel,
          attentionCount,
          viaLabel,
          readinessText,
          parseRecall,
          RECALL_DEFINITION,
        };
      }
    } catch {
      /* a restricted global must not break the module */
    }

    return { inject, apply };
  },
});
