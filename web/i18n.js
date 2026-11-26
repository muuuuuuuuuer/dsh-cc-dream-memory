import { formatError } from './format.js';
import en from '../locale/en.json';
import zh from '../locale/zh.json';

export const NS = 'dsh-cc-dream-memory';
const DICTIONARIES = { en, zh };

export function makeFallbackTranslate(ctx) {
  return (key, params) => {
    let active = 'en';
    try {
      const snapshot =
        ctx && ctx.locale && typeof ctx.locale.getLocale === 'function' ? ctx.locale.getLocale() : undefined;
      if (snapshot && typeof snapshot.active === 'string') active = snapshot.active;
    } catch {
      active = 'en';
    }
    const dictionary = String(active).toLowerCase().startsWith('zh') ? zh : en;
    let template = dictionary[key];
    if (typeof template !== 'string') template = en[key];
    if (typeof template !== 'string') return key;
    if (params && typeof params === 'object') {
      template = template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
      );
    }
    return template;
  };
}

export function registerDictionaries(ctx) {
  const locale = ctx && ctx.locale;
  if (!locale || typeof locale.register !== 'function') return false;
  try {
    ctx.effect(() => {
      try {
        return locale.register(NS, DICTIONARIES);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('[cc-memory] locale dictionary registration failed:', formatError(error));
        return () => {};
      }
    }, 'cc-memory: dictionaries');
    return true;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[cc-memory] locale effect registration failed:', formatError(error));
    return false;
  }
}
